(() => {
  const SETTINGS_KEY = "seuranta_push";
  const settings = document.getElementById("push-settings");
  const status = document.getElementById("push-status");
  const serverField = document.getElementById("push-server");
  const tokenField = document.getElementById("push-token");
  const activate = document.getElementById("push-activate");
  const test = document.getElementById("push-test");
  const sync = document.getElementById("push-sync");
  const clockTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  let config;
  try { config = JSON.parse(localStorage.getItem(SETTINGS_KEY)); } catch {}
  let publicKey;
  let registration;
  let subscription;
  let queue = Promise.resolve();
  serverField.value = config?.server || "";
  tokenField.value = config?.token || "";

  async function request(path, method, payload) {
    const response = await fetch(config.server + path, {
      method,
      headers: {
        Authorization: "Bearer " + config.token,
        ...(payload && { "Content-Type": "application/json" })
      },
      body: payload && JSON.stringify(payload)
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    return response.json();
  }

  async function connect() {
    if (!registration) throw new Error("Avaa sovellus iPhonen kotinäytöltä.");
    const url = new URL(serverField.value.trim());
    if (url.protocol !== "https:" || !url.hostname.endsWith(".workers.dev") ||
        url.username || url.password || tokenField.value.trim().length < 32) {
      throw new Error("Tarkista palvelun osoite ja yhdistämiskoodi.");
    }
    const previous = config;
    config = { server: url.origin, token: tokenField.value.trim() };
    try {
      publicKey = (await request("/config", "GET")).publicKey;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(config));
      activate.disabled = false;
      status.textContent = "Palvelu yhdistetty. Valitse Salli ilmoitukset.";
    } catch (error) {
      config = previous;
      throw error;
    }
  }

  function timeFor(task, period, schedule) {
    return getTimeRange(task.schedule).start || getTimeRange(schedule[period]).start;
  }

  function savePlan() {
    if (!subscription || !config) return Promise.resolve();
    queue = queue.catch(() => {}).then(() => {
      const tasks = loadTasks();
      const schedule = loadSchedule();
      const planned = PERIODS.flatMap(period => tasks[period].flatMap(task => {
        const time = timeFor(task, period, schedule);
        return task.notify && clockTime.test(time) ? [{ id: task.id, name: task.name, time }] : [];
      }));
      return request("/plan", "PUT", { subscription: subscription.toJSON(), tasks: planned });
    });
    return queue;
  }

  function reportFailure(error) {
    status.textContent = "Ilmoituksia ei voitu päivittää. " + error.message;
    settings.open = true;
  }

  document.getElementById("push-connect").onclick = () => connect().catch(reportFailure);
  activate.onclick = async () => {
    try {
      if (await Notification.requestPermission() !== "granted") {
        throw new Error("Salli ilmoitukset iPhonen asetuksista.");
      }
      const key = Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/") + "="),
        character => character.charCodeAt(0));
      const current = await registration.pushManager.getSubscription();
      if (current && !current.options.applicationServerKey) await current.unsubscribe();
      if (current?.options.applicationServerKey &&
          String(new Uint8Array(current.options.applicationServerKey)) !== String(key)) {
        await current.unsubscribe();
      }
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true, applicationServerKey: key
      });
      await savePlan();
      test.disabled = false;
      sync.disabled = false;
      status.textContent = "Ilmoitukset käytössä. Valitse tehtävien kellokuvakkeet.";
      render();
    } catch (error) { reportFailure(error); }
  };

  test.onclick = async () => {
    try {
      await savePlan();
      await request("/test", "POST");
      status.textContent = "Testi-ilmoitus lähetetty.";
    } catch (error) { reportFailure(error); }
  };
  sync.onclick = () => savePlan().then(() => {
    status.textContent = "Ilmoitukset päivitetty.";
  }).catch(reportFailure);

  window.seurantaPush = {
    button(task, period) {
      if (!subscription || !clockTime.test(timeFor(task, period, loadSchedule()))) return "";
      return `<button class="notify-task" aria-label="Tehtävän ilmoitus" aria-pressed="${!!task.notify}"
        data-notify="${escHtml(task.id)}" data-period="${period}">${task.notify ? "🔔" : "🔕"}</button>`;
    },
    sync() { savePlan().catch(reportFailure); }
  };
  document.addEventListener("click", async event => {
    const button = event.target.closest("[data-notify]");
    if (!button || !subscription) return;
    const tasks = loadTasks();
    const task = tasks[button.dataset.period].find(item => item.id === button.dataset.notify);
    if (!task) return;
    task.notify = !task.notify;
    saveTasks(tasks);
    render();
    try {
      await savePlan();
      status.textContent = "Ilmoitukset päivitetty.";
    } catch (error) { reportFailure(error); }
  });

  const backupStatus = document.getElementById("backup-status");
  document.getElementById("backup-save").onclick = () => {
    const data = { version: 1, tasks: loadTasks(), schedule: loadSchedule(), history: loadHistory() };
    const link = document.createElement("a");
    const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
    link.href = url;
    link.download = "asioiden-seuranta-varmuuskopio.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  function validRange(value) {
    const { start, end } = getTimeRange(value);
    return (!start || clockTime.test(start)) && (!end || clockTime.test(end));
  }

  document.getElementById("backup-open").onchange = async event => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    try {
      if (file.size > 5000000) throw new Error();
      const data = JSON.parse(await file.text());
      if (data.version !== 1 || !data.tasks || !data.schedule || !data.history ||
          !PERIODS.every(period => Array.isArray(data.tasks[period]) &&
            data.tasks[period].every(task => /^[a-z0-9]{1,48}$/i.test(task.id) &&
              typeof task.id === "string" && typeof task.name === "string" && task.name.length <= 40 &&
              validRange(task.schedule)) && validRange(data.schedule[period])) ||
          !Object.entries(data.history).every(([date, entry]) =>
            /^\d{4}-\d{2}-\d{2}$/.test(date) && entry &&
            Object.entries(entry).every(([period, values]) => PERIODS.includes(period) && values &&
              Object.entries(values).every(([id, time]) =>
                /^[a-z0-9]{1,48}$/i.test(id) && (time === null ||
                  (typeof time === "string" && /^\d{2}[.:]\d{2}$/.test(time))))))) {
        throw new Error();
      }
      if (!confirm("Korvataanko tämän laitteen tehtävät, aikavälit ja kuittaukset varmuuskopion tiedoilla?")) return;
      saveTasks(data.tasks);
      saveHistory(data.history);
      localStorage.setItem(SCHEDULE_KEY, JSON.stringify(data.schedule));
      for (const period of PERIODS) {
        const range = getTimeRange(data.schedule[period]);
        for (const field of ["start", "end"]) {
          document.getElementById(field + "-" + period).value = range[field];
        }
      }
      render();
      window.seurantaPush.sync();
      backupStatus.textContent = "Tiedot palautettu.";
    } catch {
      backupStatus.textContent = "Varmuuskopion lukeminen epäonnistui.";
    }
  };

  async function initialize() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      status.textContent = "Lisää sovellus iPhonen kotinäytölle ja avaa se kuvakkeesta.";
      return;
    }
    await navigator.serviceWorker.register("./seuranta-sw.js");
    registration = await navigator.serviceWorker.ready;
    if (!config) return;
    subscription = await registration.pushManager.getSubscription();
    if (!subscription || Notification.permission !== "granted") {
      subscription = null;
      return;
    }
    render();
    await savePlan();
    test.disabled = false;
    sync.disabled = false;
    status.textContent = "Ilmoitukset käytössä.";
  }
  initialize().catch(reportFailure);
})();
