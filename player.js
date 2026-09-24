/* Big Timestamp Player — reveal.js-safe.
   Initialises every .btp block on the page; no-ops if there are none. */
(function () {
  "use strict";

  var ytApi = null;
  function loadYtApi() {
    if (ytApi) return ytApi;
    ytApi = new Promise(function (resolve, reject) {
      var prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function () {
        if (typeof prev === "function") prev();
        resolve();
      };
      var s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      s.onerror = function () { reject(new Error("api")); };
      document.head.appendChild(s);
    });
    return ytApi;
  }

  function ytId(s) {
    s = String(s).trim();
    if (/^[\w-]{11}$/.test(s)) return s;
    var u;
    try { u = new URL(s); } catch (e) { return null; }
    if (u.hostname === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
    if (!/(^|\.)youtube(-nocookie)?\.com$/.test(u.hostname)) return null;
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    var m = u.pathname.match(/^\/(embed|shorts|live|v)\/([\w-]{11})/);
    return m ? m[2] : null;
  }

  function fmt(s) {
    if (!isFinite(s) || s < 0) s = 0;
    var m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0");
  }

  function initPlayer(root) {
    var clock = root.querySelector(".btp-clock");
    var stage = root.querySelector(".btp-stage");
    var drop  = root.querySelector(".btp-drop");
    var err   = root.querySelector(".btp-err");
    var urlIn = root.querySelector(".btp-url");

    var getTime = null, ytPlayer = null, objectUrl = null, mediaEl = null;

    function tick() {
      if (getTime) {
        var t = getTime();
        if (typeof t === "number") clock.textContent = fmt(t);
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);

    function reset() {
      err.textContent = "";
      getTime = null;
      mediaEl = null;
      if (ytPlayer) { try { ytPlayer.destroy(); } catch (e) {} ytPlayer = null; }
      if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
      stage.innerHTML = "";
      stage.hidden = true;
      clock.textContent = "00:00";
      clock.classList.add("idle");
    }

    function loadFile(file) {
      if (!file) return;
      reset();
      objectUrl = URL.createObjectURL(file);
      var v = document.createElement("video");
      v.src = objectUrl;
      v.controls = true;
      v.playsInline = true;
      v.addEventListener("error", function () {
        err.textContent = "Could not play that file — the browser may not support its codec.";
      });
      stage.appendChild(v);
      stage.hidden = false;
      mediaEl = v;
      getTime = function () { return v.currentTime; };
      clock.classList.remove("idle");
      drop.hidden = true;
      v.play().catch(function () { /* autoplay may be blocked; controls are there */ });
    }

    function loadYouTube(id) {
      reset();
      var host = document.createElement("div");
      stage.appendChild(host);
      stage.hidden = false;
      loadYtApi().then(function () {
        ytPlayer = new YT.Player(host, {
          videoId: id,
          playerVars: { playsinline: 1 },
          events: {
            onReady: function () {
              getTime = function () {
                return ytPlayer && ytPlayer.getCurrentTime ? ytPlayer.getCurrentTime() : null;
              };
              clock.classList.remove("idle");
              mediaEl = ytPlayer;
            },
            onError: function () {
              err.textContent = "That video is unavailable or the owner has disabled embedding.";
              getTime = null;
            }
          }
        });
        drop.hidden = true;
      }, function () {
        err.textContent = "Couldn't load the YouTube player API — check the network connection.";
      });
    }

    function loadUrl() {
      var id = ytId(urlIn.value);
      if (!id) { err.textContent = "That doesn't look like a YouTube link."; return; }
      loadYouTube(id);
    }

    root.querySelector(".btp-load").addEventListener("click", loadUrl);
    urlIn.addEventListener("keydown", function (e) {
      e.stopPropagation();                   // keep reveal's shortcuts out of the field
      if (e.key === "Enter") loadUrl();
    });
    root.querySelector(".btp-file").addEventListener("change", function (e) {
      loadFile(e.target.files[0]);
    });

    /* drag and drop, limited to this slide */
    ["dragenter", "dragover"].forEach(function (ev) {
      root.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add("over"); });
    });
    root.addEventListener("dragleave", function (e) {
      if (!root.contains(e.relatedTarget)) drop.classList.remove("over");
    });
    root.addEventListener("drop", function (e) {
      e.preventDefault();
      drop.classList.remove("over");
      var f = e.dataTransfer && e.dataTransfer.files[0];
      if (f) loadFile(f);
    });

    /* pause when the slide goes away, so audio doesn't follow you */
    root._btpPause = function () {
      if (!mediaEl) return;
      try {
        if (mediaEl.pauseVideo) mediaEl.pauseVideo();
        else if (mediaEl.pause) mediaEl.pause();
      } catch (e) {}
    };

    /* optional deep link: ?v=<url or id> */
    var q = new URLSearchParams(location.search).get("v");
    if (q) { urlIn.value = q; loadUrl(); }
  }

  function boot() {
    var roots = document.querySelectorAll(".btp");
    if (!roots.length) return;
    roots.forEach(initPlayer);

    /* Reveal may not have been created yet when this runs; wait briefly for it. */
    var tries = 0;
    (function hookReveal() {
      if (window.Reveal && Reveal.on) {
        Reveal.on("slidechanged", function (e) {
          document.querySelectorAll(".btp").forEach(function (r) {
            if (r._btpPause && (!e.currentSlide || !e.currentSlide.contains(r))) r._btpPause();
          });
        });
      } else if (tries++ < 50) {
        setTimeout(hookReveal, 100);
      }
    })();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
