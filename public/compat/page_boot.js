(function() {
  "use strict";
  var panel = document.getElementById("pageBoot");
  var message = document.getElementById("pageBootMessage");
  var actions = document.getElementById("pageBootActions");
  var zh = /^zh/i.test(navigator.language || "");
  try {
    zh = (localStorage.getItem("dateher_ui_language") || (zh ? "zh-cn" : "en")) === "zh-cn";
  } catch (_) {
  }
  message.textContent = zh ? "正在加载画图页面…" : "Loading your drawing page…";
  document.getElementById("pageBootRetry").textContent = zh ? "重新加载" : "Reload";
  document.getElementById("pageBootLogin").textContent = zh ? "返回登录" : "Back to login";
  document.getElementById("pageBootRetry").onclick = function() {
    location.reload();
  };
  function fail(detail) {
    if (!panel || !panel.parentNode) return;
    document.body.hidden = false;
    message.textContent = (zh ? "页面加载失败，请重试。" : "The page could not load. Please retry.") + (detail ? "\n" + String(detail) : "");
    actions.hidden = false;
  }
  var timer = setTimeout(function() {
    fail(zh ? "网络响应超时。" : "The network response timed out.");
  }, 25e3);
  window.pageBoot = {
    fail,
    complete: function() {
      clearTimeout(timer);
      if (panel.parentNode) panel.parentNode.removeChild(panel);
    },
    fetch: function(url, options) {
      options = options || {};
      var controller = typeof AbortController === "function" ? new AbortController() : null;
      if (controller) options.signal = controller.signal;
      var timeout;
      var deadline = new Promise(function(_, reject) {
        timeout = setTimeout(function() {
          reject(new Error(zh ? "网络请求超时，请重试。" : "Network request timed out. Please retry."));
          if (controller) controller.abort();
        }, String(url).indexOf("/api/") === 0 ? 35e3 : 15e3);
      });
      return Promise.race([fetch(url, options), deadline]).then(function(response) {
        clearTimeout(timeout);
        return response;
      }, function(error) {
        clearTimeout(timeout);
        throw error;
      });
    }
  };
  window.addEventListener("error", function(event) {
    var target = event.target;
    if (target && target.tagName === "SCRIPT") fail(zh ? "浏览器未能加载页面脚本。" : "The browser could not load a page script.");
    else if (event.message) fail(event.message);
  }, true);
})();
