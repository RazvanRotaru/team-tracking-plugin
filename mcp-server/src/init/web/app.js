const state = { adapter: null, step: 1 };

function setStep(n) {
  state.step = n;
  for (const li of document.querySelectorAll(".steps li")) {
    li.classList.toggle("active", Number(li.dataset.step) === n);
  }
  for (const sec of document.querySelectorAll(".screen")) {
    sec.classList.toggle("active", Number(sec.dataset.screen) === n);
  }
}

function showAdapterForm(adapter) {
  for (const f of document.querySelectorAll(".adapter-form")) {
    f.classList.toggle("active", f.id === `form-${adapter}`);
  }
}

function gatherConfig() {
  const form = document.querySelector(`#form-${state.adapter}`);
  const data = new FormData(form);
  const get = (k) => String(data.get(k) ?? "").trim();

  if (state.adapter === "obsidian-kanban") {
    return {
      version: 1,
      adapter: "obsidian-kanban",
      adapterConfig: { vaultPath: get("vaultPath") },
      projects: [{ name: get("projectName"), adapterProjectRef: get("adapterProjectRef") }],
      lockTtlSeconds: 1800,
    };
  }
  if (state.adapter === "jira") {
    return {
      version: 1,
      adapter: "jira",
      adapterConfig: {
        baseUrl: get("baseUrl"),
        email: get("email"),
        apiToken: get("apiToken"),
        statusMap: {
          Backlog: get("status_Backlog"),
          Todo: get("status_Todo"),
          "In Progress": get("status_InProgress"),
          "In Review": get("status_InReview"),
          Done: get("status_Done"),
          Blocked: get("status_Blocked"),
        },
      },
      projects: [{ name: get("projectName"), adapterProjectRef: get("adapterProjectRef") }],
      lockTtlSeconds: 1800,
    };
  }
  throw new Error("no adapter selected");
}

document.addEventListener("DOMContentLoaded", () => {
  for (const tile of document.querySelectorAll(".tile")) {
    tile.addEventListener("click", () => {
      state.adapter = tile.dataset.adapter;
      showAdapterForm(state.adapter);
      setStep(2);
    });
  }
  for (const back of document.querySelectorAll("[data-back]")) {
    back.addEventListener("click", () => setStep(state.step - 1));
  }
  for (const next of document.querySelectorAll("[data-next]")) {
    next.addEventListener("click", () => {
      const form = document.querySelector(`#form-${state.adapter}`);
      if (!form.reportValidity()) return;
      const cfg = gatherConfig();
      document.querySelector("#preview").textContent = JSON.stringify(cfg, null, 2);
      setStep(3);
    });
  }
  document.querySelector("#save").addEventListener("click", async () => {
    const status = document.querySelector("#status");
    status.className = "";
    status.textContent = "Saving…";
    try {
      const token = new URLSearchParams(location.search).get("t");
      const res = await fetch(`/save?t=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(gatherConfig()),
      });
      if (!res.ok) {
        const text = await res.text();
        status.classList.add("error");
        status.textContent = `error: ${text}`;
        return;
      }
      const out = await res.json();
      status.classList.add("success");
      status.textContent = `saved to ${out.configPath}. you can close this tab.`;
    } catch (e) {
      status.classList.add("error");
      status.textContent = `error: ${e.message ?? e}`;
    }
  });
});
