// public/static/js/staffGym.js
(function () {
  const startBtn = document.getElementById("startScanBtn");
  const stopBtn = document.getElementById("stopScanBtn");
  const videoWrap = document.getElementById("videoWrap");
  const videoEl = document.getElementById("cameraPreview");
  const canvas = document.getElementById("hiddenCanvas");
  const visitList = document.getElementById("visitList");

  const totalVisitsEl = document.getElementById("totalVisits");
  const subscribedVisitsEl = document.getElementById("subscribedVisits");
  const notSubscribedVisitsEl = document.getElementById("notSubscribedVisits");
  const scanStatusEl = document.getElementById("scanStatus");
  const scanOverlay = document.getElementById("scanOverlay");

  let stream = null;
  let scanning = false; // whether capture+upload loop is active
  let cameraActive = false; // whether camera stream is active
  let scanLoopTimer = null;
  let attempts = 0;
  const CAPTURE_INTERVAL_MS = 1200;
  const POST_MATCH_COOLDOWN_MS = 3000; // short pause after a match to reduce duplicates
  const SAME_USER_DEBOUNCE_MS = 10000; // ignore same user for 10s
  const MAX_ATTEMPTS = 1000000; // effectively unlimited while camera is on

  // track last matched user id -> timestamp to avoid immediate duplicates
  const lastMatched = new Map();

  function escapeHtml(s) {
    if (!s) return "";
    return String(s).replace(
      /[&<>"']/g,
      (ch) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }[ch])
    );
  }

  function prependVisit(student) {
    const item = document.createElement("div");
    item.className = "sm-visit-item";
    if (student.id) item.setAttribute("data-id", student.id);

    const photoHtml =
      student.photo_path || student.photo_url
        ? `<img src="${escapeHtml(
            student.photo_path || student.photo_url
          )}" alt="photo" class="sm-thumb">`
        : "";

    item.innerHTML = `
      <div class="sm-visit-left">
        ${photoHtml}
        <div>
          <p class="sm-visit-item-name">${escapeHtml(
            student.student_name || student.name || "Unknown"
          )}</p>
          <i class="sm-visit-item-id">${escapeHtml(
            student.student_id || student.id || ""
          )}</i>
        </div>
      </div>
      <div class="sm-visit-middle">${
        student.gym_active === true
          ? "Subscribed"
          : student.gym_active === false
          ? "Not Subscribed"
          : student.category || ""
      }</div>
      <div class="sm-visit-right">Checked</div>
    `;
    if (visitList.firstChild)
      visitList.insertBefore(item, visitList.firstChild);
    else visitList.appendChild(item);
  }

  function updateTotalsOnMatch(rv) {
    try {
      const totalEl = totalVisitsEl;
      const subEl = subscribedVisitsEl;
      const notEl = notSubscribedVisitsEl;

      const total = Number(totalEl.textContent || 0) + 1;
      totalEl.textContent = total;

      if (rv.gym_active) {
        subEl.textContent = Number(subEl.textContent || 0) + 1;
      } else {
        notEl.textContent = Number(notEl.textContent || 0) + 1;
      }
    } catch (e) {
      // ignore
    }
  }

  function setStatus(s) {
    if (scanStatusEl) scanStatusEl.textContent = s;
    if (scanOverlay)
      scanOverlay.style.display = s && s !== "Stopped" ? "block" : "none";
  }

  function captureFrameBlob() {
    if (!videoEl || !videoEl.videoWidth) return null;
    const w = videoEl.videoWidth;
    const h = videoEl.videoHeight;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(videoEl, 0, 0, w, h);
    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.8);
    });
  }

  async function sendProbe(blob) {
    try {
      const fd = new FormData();
      fd.append("image", blob, "probe.jpg");
      const res = await fetch("/api/staff/gym/scan", {
        method: "POST",
        body: fd,
        credentials: "same-origin",
      });
      const j = await res.json().catch(() => null);
      return j;
    } catch (err) {
      console.error("sendProbe error:", err);
      return { ok: false, message: "Network/request failed" };
    }
  }

  // The continuous loop: capture -> send -> process -> repeat until stop clicked
  async function continuousScanStep() {
    if (!scanning) return;
    attempts++;
    // no max attempts: camera runs until stopped

    if (!stream || !videoEl || videoEl.readyState < 2) {
      // try again on next tick
      scanLoopTimer = setTimeout(
        () => requestAnimationFrame(continuousScanStep),
        CAPTURE_INTERVAL_MS
      );
      return;
    }

    const blob = await captureFrameBlob();
    if (!blob) {
      scanLoopTimer = setTimeout(
        () => requestAnimationFrame(continuousScanStep),
        CAPTURE_INTERVAL_MS
      );
      return;
    }

    setStatus("Scanning...");

    const result = await sendProbe(blob);

    if (!result || !result.ok) {
      // transient error, continue
      scanLoopTimer = setTimeout(
        () => requestAnimationFrame(continuousScanStep),
        CAPTURE_INTERVAL_MS
      );
      return;
    }

    if (result.matched) {
      // prevent immediate repeated matches for same user
      const matchedId = result.student && result.student.id;
      const now = Date.now();
      if (matchedId) {
        const last = lastMatched.get(matchedId) || 0;
        if (now - last < SAME_USER_DEBOUNCE_MS) {
          // ignore duplicate match for same user within debounce window
          setStatus(`Matched recently (${result.student.name}) — continuing`);
          scanLoopTimer = setTimeout(
            () => requestAnimationFrame(continuousScanStep),
            CAPTURE_INTERVAL_MS
          );
          return;
        }
        lastMatched.set(matchedId, now);
      }

      // apply UI updates immediately
      setStatus(
        "Matched: " +
          (result.student ? result.student.name : "") +
          (result.confidence
            ? " (" + Number(result.confidence).toFixed(1) + ")"
            : "")
      );

      if (result.recentVisit) {
        // server provided recentVisit object (from insert)
        prependVisit(result.recentVisit);
        updateTotalsOnMatch(result.recentVisit);
      } else if (result.student) {
        // fallback: use student object returned
        prependVisit({
          id: result.inserted_visit_id || null,
          student_id: result.student.student_id,
          student_name: result.student.name,
          gym_active: result.student.gym_active,
          photo_path: result.student.photo_url,
          created_at: new Date().toISOString(),
        });
        updateTotalsOnMatch(result.student);
      }

      // short cooldown to avoid duplicate immediate requests (camera stays on)
      scanLoopTimer = setTimeout(
        () => requestAnimationFrame(continuousScanStep),
        POST_MATCH_COOLDOWN_MS
      );
      return;
    } else {
      // no match
      if (typeof result.confidence !== "undefined") {
        setStatus(
          "No match (best: " + Number(result.confidence).toFixed(1) + ")"
        );
      } else {
        setStatus("No match — scanning...");
      }
      scanLoopTimer = setTimeout(
        () => requestAnimationFrame(continuousScanStep),
        CAPTURE_INTERVAL_MS
      );
    }
  }

  // Start camera stream if not already active
  async function startCameraIfNeeded() {
    if (cameraActive && stream) return;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      videoEl.srcObject = stream;
      await videoEl.play();
      videoWrap && videoWrap.classList.add("active");
      cameraActive = true;
      setStatus("Camera active");
    } catch (err) {
      throw err;
    }
  }

  // Start camera and scanning loop
  async function startScanning() {
    if (scanning) return;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    attempts = 0;

    try {
      await startCameraIfNeeded();
    } catch (err) {
      alert("Camera access denied or not available.");
      scanning = false;
      startBtn.disabled = false;
      stopBtn.disabled = true;
      videoWrap && videoWrap.classList.remove("active");
      setStatus("Camera error");
      return;
    }

    scanning = true;
    setStatus("Camera started — scanning...");
    // small warmup then begin loop
    setTimeout(() => {
      if (!scanning) return;
      requestAnimationFrame(continuousScanStep);
    }, 600);
  }

  // Stop scanning and stop camera tracks
  function stopScanning() {
    scanning = false;
    startBtn.disabled = false;
    stopBtn.disabled = true;

    if (scanLoopTimer) {
      clearTimeout(scanLoopTimer);
      scanLoopTimer = null;
    }

    if (stream) {
      try {
        stream.getTracks().forEach((t) => t.stop());
      } catch (e) {}
      stream = null;
    }
    cameraActive = false;
    if (videoEl) {
      try {
        videoEl.pause();
      } catch (e) {}
      videoEl.srcObject = null;
    }
    videoWrap && videoWrap.classList.remove("active");
    setStatus("Stopped");
  }

  // Wire buttons
  startBtn.addEventListener("click", () => {
    // If camera is active but scanning paused, resume scanning
    if (cameraActive && !scanning) {
      scanning = true;
      startBtn.disabled = true;
      stopBtn.disabled = false;
      setStatus("Resuming scan...");
      requestAnimationFrame(continuousScanStep);
      return;
    }
    // otherwise start camera + scanning
    startScanning();
  });

  stopBtn.addEventListener("click", () => {
    stopScanning();
  });

  (function themeToggleInit() {
    const themeToggle = document.getElementById("themeToggle");
    try {
      const saved = localStorage.getItem("sc_theme");
      if (saved === "dark") {
        document.documentElement.classList.add("dark");
        themeToggle.textContent = "🌙 Dark";
      } else themeToggle.textContent = "🌞 Light";
      themeToggle.addEventListener("click", () => {
        const dark = document.documentElement.classList.toggle("dark");
        localStorage.setItem("sc_theme", dark ? "dark" : "light");
        themeToggle.textContent = dark ? "🌙 Dark" : "🌞 Light";
      });
    } catch (err) {
      console.log(err);
    }
  })();

  // expose for debugging/control
  window._staffGym = { startScanning, stopScanning };
})();
