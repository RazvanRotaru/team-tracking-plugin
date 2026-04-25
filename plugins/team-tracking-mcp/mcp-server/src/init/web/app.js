"use strict";

// team-tracking-mcp · setup wizard
// State machine: state.step ∈ {1,2,3}, state.adapter ∈ {"obsidian-kanban","jira"}.
// JS owns class toggles (.active on .steps li, .screen, .adapter-form), the
// preview text, and the POST. All visual styling lives in style.css.

const state = { adapter: null, step: 1 };

function setStep(n) {
  state.step = n;
  for (const li of document.querySelectorAll(".steps li")) {
    li.classList.toggle("active", Number(li.dataset.step) === n);
  }
  for (const sec of document.querySelectorAll(".screen")) {
    sec.classList.toggle("active", Number(sec.dataset.screen) === n);
  }

  // Quality of life: focus the right element after a transition. RAF so the
  // previous screen has finished reflowing before we steal focus.
  requestAnimationFrame(() => {
    if (n === 2) {
      const form = document.querySelector(`#form-${state.adapter}.adapter-form`);
      form?.querySelector("input")?.focus();
    } else if (n === 3) {
      document.querySelector("#save")?.focus();
    }
  });
}

function showAdapterForm(adapter) {
  for (const f of document.querySelectorAll(".adapter-form")) {
    f.classList.toggle("active", f.id === `form-${adapter}`);
  }
}

function gatherConfig() {
  const form = document.querySelector(`#form-${state.adapter}`);
  if (!form) throw new Error("no adapter selected");
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

function advanceFromConfigure() {
  const form = document.querySelector(`#form-${state.adapter}`);
  if (!form?.reportValidity()) return;
  const cfg = gatherConfig();
  document.querySelector("#preview").textContent = JSON.stringify(cfg, null, 2);
  setStep(3);
}

async function postConfig() {
  const status = document.querySelector("#status");
  const save = document.querySelector("#save");
  status.className = "";
  status.textContent = "writing config…";
  save.disabled = true;

  try {
    const token = new URLSearchParams(location.search).get("t");
    const res = await fetch(`/save?t=${encodeURIComponent(token ?? "")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(gatherConfig()),
    });
    if (!res.ok) {
      const text = await res.text();
      status.classList.add("error");
      status.textContent = text || `request failed (${res.status})`;
      save.disabled = false;
      return;
    }
    const out = await res.json();
    status.classList.add("success");
    status.textContent = `wrote ${out.configPath} — you can close this tab.`;
    // Server shuts down after save; keep the button disabled to make it obvious.
  } catch (e) {
    status.classList.add("error");
    status.textContent = (e && e.message) ? e.message : String(e);
    save.disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  // Tile selection → step 2
  for (const tile of document.querySelectorAll(".tile")) {
    tile.addEventListener("click", () => {
      state.adapter = tile.dataset.adapter;
      showAdapterForm(state.adapter);
      setStep(2);
    });
  }

  // Back buttons
  for (const back of document.querySelectorAll("[data-back]")) {
    back.addEventListener("click", () => {
      if (state.step > 1) setStep(state.step - 1);
    });
  }

  // Next buttons → validate + render preview + step 3
  for (const next of document.querySelectorAll("[data-next]")) {
    next.addEventListener("click", advanceFromConfigure);
  }

  // Pressing Enter inside a form should advance, not submit/reload the page.
  for (const form of document.querySelectorAll(".adapter-form")) {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (state.step === 2) advanceFromConfigure();
    });
  }

  // Save (step 3)
  document.querySelector("#save").addEventListener("click", postConfig);

  // Esc → back
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.step > 1) setStep(state.step - 1);
  });
});
