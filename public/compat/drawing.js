var CHARS = {};
var CFG = {};
var PERSONALITY_FACE_TAGS = {};
var CAMERAS = [];
var fixedCamera = "";
var shotDefault = "full body";
var SCENE_NL = {};
var POSES = [];
var EXPRESSIONS = [];
var HAND_GESTURES = [];
var LIGHTING = [];
var EM = [];
var VW = [];
var RA = [];
var TI = {};
var LO_REGULAR = [];
var LO_OUTDOOR = [];
var LO_URBAN = [];
var LO_FANTASY = [];
var LO_SCIFI = [];
var LO_SPECIAL = [];
var RANDOM_CLOTHING = [];
var COLOR_OPTIONS = [];
var RANDOM_SHOES = [];
var SCENE_PROMPTS = {};
var SCENE_TONES = {};
var scenePrompts = {};
var sceneLocations = {};
var storyStyle = "auto";
var storyTone = "";
var promptLang = "tag";
var lastToneUsed = null;
var selectedChar = null;
var currentGame = "genshin";
var GS = { genshin: "genshin_impact", hsr: "honkai_star_rail", zzz: "zenless_zone_zero", wuwa: "wuthering_waves", endfield: "arknights_endfield", NevernessToEverness: "neverness_to_everness", ananta: "ananta" };
var sceneCounts = { daytime: 1, sunset: 1, night: 1 };
var currentSession = "";
var sessionImages = {};
var lockedColor = null;
var MAX_SCENES = 20;
function pick(a) {
  return a[Math.floor(Math.random() * a.length)];
}
function ec(s) {
  s = s.trim();
  if (s && !s.endsWith(",")) s += ",";
  return s;
}
function bootFetch(path, options) {
  return window.pageBoot ? window.pageBoot.fetch(path, options) : fetch(path, options);
}
function fetchConfigs() {
  var t = Date.now();
  return Promise.all([
    bootFetch("prompt_config.json?t=" + t).then(function(r) {
      return r.json();
    }),
    bootFetch("char_tags.json?t=" + t).then(function(r) {
      return r.json();
    }),
    bootFetch("personality_face_tags.json?t=" + t).then(function(r) {
      return r.json();
    }),
    bootFetch("scene_prompts.json?t=" + t).then(function(r) {
      return r.json();
    }),
    bootFetch("scene_prompts_nl.json?t=" + t).then(function(r) {
      return r.json();
    })
  ]);
}
function applyConfigs(results, initial) {
  if (results[0]) CFG = results[0];
  if (results[1]) CHARS = results[1];
  PERSONALITY_FACE_TAGS = results[2] && results[2].personality_face_tags || {};
  var sp = results[3] || {};
  SCENE_NL = results[4] || {};
  SCENE_TONES = {};
  if (sp.default) {
    SCENE_PROMPTS = sp.default;
    Object.keys(sp).forEach(function(k) {
      if (k.charAt(0) === "_" || k === "default") return;
      SCENE_TONES[k] = sp[k];
    });
  } else if (Object.keys(sp).length) {
    SCENE_PROMPTS = sp;
  }
  CAMERAS = CFG.cameras || [];
  POSES = CFG.poses || [];
  EXPRESSIONS = CFG.expressions || [];
  HAND_GESTURES = CFG.handGestures || [];
  LIGHTING = CFG.lighting || [];
  EM = CFG.emotionForEach || [];
  VW = CFG.viewForEach || [];
  RA = CFG.globalRatioPrompts || [];
  TI = CFG.timeForAll || {};
  LO_REGULAR = CFG.locationRegular || [];
  LO_OUTDOOR = CFG.locationOutdoor || [];
  LO_URBAN = CFG.locationUrban || [];
  LO_FANTASY = CFG.locationFantasy || [];
  LO_SCIFI = CFG.locationScifi || [];
  LO_SPECIAL = CFG.locationSpecial || [];
  RANDOM_CLOTHING = CFG.randomClothing || [];
  COLOR_OPTIONS = CFG.colorOptions || [];
  RANDOM_SHOES = CFG.randomShoes || [];
  if (initial && CFG.shotDefault && document.getElementById("shotDefault")) {
    shotDefault = CFG.shotDefault;
    document.getElementById("shotDefault").value = shotDefault;
  }
  if (document.getElementById("fixedCameraSelect")) renderCameraOptions();
  return true;
}
function loadData() {
  return fetchConfigs().then(function(results) {
    return applyConfigs(results, true);
  });
}
function reloadConfigs(resetPrompts) {
  return fetchConfigs().then(function(results) {
    applyConfigs(results, false);
    if (resetPrompts) {
      scenePrompts = {};
      lastToneUsed = void 0;
      renderSceneConfig();
    }
    syncLocationLabels();
    return true;
  });
}
function getUsedScenes() {
  return sceneCounts.daytime + sceneCounts.sunset + sceneCounts.night + 2;
}
function getActiveTone() {
  if (storyStyle === "auto") return selectedChar && selectedChar.personalityTone || "";
  if (storyStyle === "manual") return storyTone || "";
  return "";
}
function getStoryPack() {
  var t = getActiveTone();
  return t && SCENE_TONES[t] || null;
}
function getScenePool(cat) {
  if (promptLang === "nl") {
    var nt = getActiveTone();
    if (nt && SCENE_NL[nt] && SCENE_NL[nt][cat] && SCENE_NL[nt][cat].length) return SCENE_NL[nt][cat];
    var nb = SCENE_NL.default && SCENE_NL.default[cat] ? SCENE_NL.default : SCENE_NL;
    return nb && nb[cat] || [];
  }
  var pack = getStoryPack();
  if (pack && pack[cat] && pack[cat].length) return pack[cat];
  return SCENE_PROMPTS[cat] || [];
}
function onPromptLangChange() {
  var r = document.querySelector('input[name="promptLang"]:checked');
  promptLang = r ? r.value : "tag";
  scenePrompts = {};
  lastToneUsed = void 0;
  renderSceneConfig();
  updateStoryStyleUI();
}
function getToneSelect() {
  var sel = document.getElementById("storyToneSelect");
  if (sel && !sel.options.length) {
    Object.keys(SCENE_TONES).sort().forEach(function(t) {
      var o = document.createElement("option");
      o.value = t;
      o.textContent = t + (SCENE_TONES[t]._label ? " (" + SCENE_TONES[t]._label + ")" : "");
      sel.appendChild(o);
    });
  }
  return sel;
}
function updateStoryStyleUI() {
  var hint = document.getElementById("storyHint");
  if (!hint) return;
  var t = getActiveTone();
  var pack = t && SCENE_TONES[t] ? SCENE_TONES[t] : null;
  if (storyStyle === "auto") {
    if (!selectedChar) {
      hint.textContent = "选角色后自动套用其性格剧情包";
      return;
    }
    hint.textContent = pack ? "→ " + t + " 《" + (pack._label || t) + "》" : "→ " + (selectedChar.personalityTone || "无 tone") + "：无专属包，回落通用模板";
    return;
  }
  if (storyStyle === "manual") {
    hint.textContent = pack ? "→ " + t + " 《" + (pack._label || t) + "》" : "→ 未选择（回落通用模板）";
    return;
  }
  hint.textContent = "→ 通用模板 default";
}
function onStoryContextChange() {
  var t = getActiveTone();
  if (t !== lastToneUsed) {
    lastToneUsed = t;
    scenePrompts = {};
  }
  updateStoryStyleUI();
  renderSceneConfig();
}
function onStoryStyleChange() {
  var r = document.querySelector('input[name="storyStyle"]:checked');
  storyStyle = r ? r.value : "auto";
  var sel = getToneSelect();
  if (sel) {
    sel.style.display = storyStyle === "manual" ? "" : "none";
    if (storyStyle === "manual" && sel.value) storyTone = sel.value;
  }
  onStoryContextChange();
}
function onStoryToneChange() {
  var sel = getToneSelect();
  if (sel) storyTone = sel.value;
  onStoryContextChange();
}
function adjCount(cat, delta) {
  var cur = sceneCounts[cat];
  var next = Math.max(1, cur + delta);
  if (next > 10) next = 10;
  sceneCounts[cat] = next;
  renderSceneConfig();
  updateSceneTotal();
  renderSlots();
}
var LOC_CATS = ["opening", "daytime", "sunset", "night", "confession"];
var LOC_LABELS = { opening: "Opening", daytime: "Daytime", sunset: "Sunset", night: "Night", confession: "Confession" };
function syncLocationLabels() {
  LOC_CATS.forEach(function(k) {
    var el = document.getElementById("locValue_" + k);
    if (!el) return;
    el.textContent = tr(sceneLocations[k] ? sceneLocations[k].replace(/,$/, "") : "random");
    el.style.color = sceneLocations[k] ? "#9fd0ff" : "#888";
  });
}
function renderLocationConfig() {
  var area = document.getElementById("locationArea");
  if (!area) return;
  var locCats = ["regular", "outdoor", "urban", "fantasy", "scifi", "special"];
  var html = "";
  var modes = {};
  LOC_CATS.forEach(function(k) {
    var cur = sceneLocations[k];
    var mode = "random";
    if (cur) {
      mode = "select";
      for (var i = 0; i < locCats.length; i++) {
        if (locPoolByName(locCats[i]).indexOf(cur) >= 0) {
          mode = locCats[i];
          break;
        }
      }
    }
    modes[k] = mode;
    html += '<div class="loc-row">';
    html += '<div class="loc-row-head">';
    html += '<span class="loc-cat">' + LOC_LABELS[k] + "</span>";
    html += '<span class="loc-value" id="locValue_' + k + '">random</span>';
    html += "</div>";
    html += '<div class="radio-group">';
    html += '<label style="font-size:12px"><input type="radio" name="catLoc_' + k + '" value="random"' + (mode === "random" ? " checked" : "") + " onchange=\"onCatLocChange('" + k + "')\">Random</label>";
    locCats.forEach(function(lc) {
      html += '<label style="font-size:12px"><input type="radio" name="catLoc_' + k + '" value="' + lc + '"' + (mode === lc ? " checked" : "") + " onchange=\"onCatLocChange('" + k + "')\">" + lc.charAt(0).toUpperCase() + lc.slice(1) + "</label>";
    });
    html += '<label style="font-size:12px"><input type="radio" name="catLoc_' + k + '" value="select"' + (mode === "select" ? " checked" : "") + " onchange=\"onCatLocChange('" + k + "')\">Select</label>";
    html += "</div>";
    html += '<div id="catLocList_' + k + '" style="display:none">';
    html += '<input type="text" id="catLocSearch_' + k + '" placeholder="Search..." class="select-search" oninput="filterCatLoc(\'' + k + "')\">";
    html += '<div id="catLocItems_' + k + '" class="select-list"></div>';
    html += "</div>";
    html += "</div>";
  });
  area.innerHTML = html;
  LOC_CATS.forEach(function(k) {
    if (modes[k] !== "random") {
      var w = document.getElementById("catLocList_" + k);
      if (w) w.style.display = "block";
      renderCatLocItems(k, modes[k]);
    }
  });
  syncLocationLabels();
}
function renderSceneConfig() {
  var area = document.getElementById("sceneConfigArea");
  var cats = [
    { key: "opening", label: "Opening", fixed: 1 },
    { key: "daytime", label: "Daytime", fixed: 0 },
    { key: "sunset", label: "Sunset", fixed: 0 },
    { key: "night", label: "Night", fixed: 0 },
    { key: "confession", label: "Confession", fixed: 1 }
  ];
  var html = "";
  cats.forEach(function(c) {
    var count = c.fixed || sceneCounts[c.key];
    if (!scenePrompts[c.key]) scenePrompts[c.key] = [];
    while (scenePrompts[c.key].length < count) {
      var arr = getScenePool(c.key);
      scenePrompts[c.key].push(arr.length ? pick(arr) : "");
    }
    while (scenePrompts[c.key].length > count) scenePrompts[c.key].pop();
    html += '<div class="scene-block">';
    html += '<div class="scene-block-header">';
    html += '<span class="label">' + c.label + "</span>";
    if (sceneLocations[c.key]) {
      html += '<span style="color:#e94560;font-size:11px;margin-left:4px">[' + escapeHtml(tr(sceneLocations[c.key].replace(/,$/, ""))) + "]</span>";
    }
    if (c.fixed) {
      html += '<span style="color:#888;font-size:12px">' + c.fixed + " scene</span>";
    } else {
      html += "<button onclick=\"adjCount('" + c.key + '\',-1)" style="background:#533483;border:none;color:#e0e0e0;width:22px;height:22px;border-radius:4px;cursor:pointer;font-size:14px">-</button>';
      html += '<span style="min-width:20px;text-align:center;font-weight:bold">' + sceneCounts[c.key] + "</span>";
      html += "<button onclick=\"adjCount('" + c.key + '\',1)" style="background:#533483;border:none;color:#e0e0e0;width:22px;height:22px;border-radius:4px;cursor:pointer;font-size:14px">+</button>';
    }
    html += "</div>";
    html += '<div style="padding:4px 12px">';
    for (var i = 0; i < count; i++) {
      var prompt = scenePrompts[c.key][i] || "";
      var displayText = describePrompt(prompt, c.key);
      var shortText = displayText;
      if (shortText.length > 60) shortText = shortText.substring(0, 58) + "...";
      html += '<div class="scene-item">';
      html += '<span class="s-idx">' + (i + 1) + "</span>";
      html += '<span class="s-text" title="' + escapeHtml(displayText) + '">' + escapeHtml(shortText) + "</span>";
      html += '<button class="s-pick" onclick="pickDifferent(\'' + c.key + "'," + i + ')">pick</button>';
      if (!c.fixed && count > 1) {
        html += '<button class="s-rm" onclick="adjCount(\'' + c.key + "',-1)\">x</button>";
      }
      html += "</div>";
    }
    html += "</div></div>";
  });
  area.innerHTML = html;
}
function pickDifferent(cat, idx) {
  var arr = getScenePool(cat);
  if (!arr.length) return;
  var old = scenePrompts[cat][idx];
  var attempts = 0;
  do {
    scenePrompts[cat][idx] = pick(arr);
    attempts++;
  } while (scenePrompts[cat][idx] === old && attempts < 10);
  renderSceneConfig();
}
function onCatLocChange(cat) {
  var r = document.querySelector('input[name="catLoc_' + cat + '"]:checked');
  var mode = r ? r.value : "random";
  var listWrap = document.getElementById("catLocList_" + cat);
  if (mode === "random") {
    if (listWrap) listWrap.style.display = "none";
    sceneLocations[cat] = null;
  } else {
    if (listWrap) listWrap.style.display = "block";
    renderCatLocItems(cat, mode);
  }
  syncLocationLabels();
  renderSceneConfig();
}
function renderCatLocItems(cat, mode) {
  var list = document.getElementById("catLocItems_" + cat);
  if (!list) return;
  list.innerHTML = "";
  var items = [];
  if (mode === "regular") items = LO_REGULAR;
  else if (mode === "outdoor") items = LO_OUTDOOR;
  else if (mode === "urban") items = LO_URBAN;
  else if (mode === "fantasy") items = LO_FANTASY;
  else if (mode === "scifi") items = LO_SCIFI;
  else if (mode === "special") items = LO_SPECIAL;
  else if (mode === "select") items = [].concat(LO_REGULAR, LO_OUTDOOR, LO_URBAN, LO_FANTASY, LO_SCIFI, LO_SPECIAL);
  items.forEach(function(item, idx) {
    var el = document.createElement("div");
    el.className = "select-item" + (sceneLocations[cat] === item ? " active" : "");
    var label = item.replace(/,$/, "").trim();
    label = optionLabel(item, label);
    el.textContent = label;
    el.dataset.rawValue = item;
    el.title = label;
    el.onclick = function() {
      sceneLocations[cat] = item;
      list.querySelectorAll(".select-item").forEach(function(e) {
        e.classList.remove("active");
      });
      el.classList.add("active");
      syncLocationLabels();
      renderSceneConfig();
    };
    list.appendChild(el);
  });
}
function filterCatLoc(cat) {
  var q = (document.getElementById("catLocSearch_" + cat) || {}).value || "";
  q = q.toLowerCase();
  var list = document.getElementById("catLocItems_" + cat);
  if (!list) return;
  list.querySelectorAll(".select-item").forEach(function(e) {
    e.style.display = ((e.dataset.rawValue || "") + " " + e.textContent).toLowerCase().indexOf(q) >= 0 ? "" : "none";
  });
}
function updateSceneTotal() {
  var total = getUsedScenes();
  document.getElementById("sceneTotal").textContent = total + "/" + MAX_SCENES + " scenes";
  document.getElementById("slotCount").textContent = total;
}
function buildSlot(grid, cat, num, pw, ph) {
  var _a;
  var card = document.createElement("div");
  card.className = "slot-card";
  var img = sessionImages[num];
  if (!img) {
    card.style.width = pw + "px";
    card.style.height = ph + "px";
    card.innerHTML = '<div class="s-num">' + num + '</div><div class="s-cat">' + cat.name + "</div>";
    grid.appendChild(card);
    return;
  }
  card.classList.add("slot-loaded");
  var el = document.createElement("img");
  el.loading = "lazy";
  card.appendChild(el);
  var n = document.createElement("div");
  n.className = "s-num";
  n.textContent = num;
  card.appendChild(n);
  var c = document.createElement("div");
  c.className = "s-cat";
  c.textContent = tr(cat.name);
  card.appendChild(c);
  var hov = document.createElement("div");
  hov.className = "slot-hover";
  var btn = document.createElement("button");
  btn.className = "btn-regen";
  btn.textContent = tr("Regenerate");
  btn.setAttribute("aria-busy", String(!!((_a = regenPending.get(currentSession + ":" + num)) == null ? void 0 : _a.busy)));
  btn.onclick = function(e) {
    e.stopPropagation();
    regenOne(num);
  };
  hov.appendChild(btn);
  card.appendChild(hov);
  card.style.width = pw + "px";
  var dpr = window.devicePixelRatio || 1;
  card.style.width = img.width / 4 / dpr + "px";
  card.style.height = img.height / 4 / dpr + "px";
  el.style.width = img.width / 4 / dpr + "px";
  el.style.height = img.height / 4 / dpr + "px";
  el.onload = function() {
    c.textContent = tr(cat.name) + " · " + img.width + "×" + img.height;
  };
  el.src = img.url;
  var dl = document.createElement("button");
  dl.textContent = tr("Download original");
  dl.onclick = function(e) {
    e.stopPropagation();
    downloadImage(num);
  };
  hov.appendChild(dl);
  grid.appendChild(card);
}
function renderSlots() {
  var total = getUsedScenes();
  var grid = document.getElementById("slotGrid");
  grid.innerHTML = "";
  var cfgSize = getImageSize();
  var dpr = window.devicePixelRatio || 1;
  var pw = cfgSize.width / 4 / dpr;
  var ph = cfgSize.height / 4 / dpr;
  for (var k in sessionImages) {
    var si = sessionImages[k];
    if (si && si.width && si.height) {
      pw = si.width / 4 / dpr;
      ph = si.height / 4 / dpr;
      break;
    }
  }
  var cats = [
    { name: "Opening", count: 1 },
    { name: "Daytime", count: sceneCounts.daytime },
    { name: "Sunset", count: sceneCounts.sunset },
    { name: "Night", count: sceneCounts.night },
    { name: "Confession", count: 1 }
  ];
  var num = 1;
  cats.forEach(function(cat) {
    for (var i2 = 0; i2 < cat.count; i2++) {
      buildSlot(grid, cat, num, pw, ph);
      num++;
    }
  });
  for (var i = num; i <= MAX_SCENES; i++) {
    var card = document.createElement("div");
    card.className = "slot-card empty";
    card.style.width = pw + "px";
    card.style.height = ph + "px";
    card.innerHTML = '<div class="s-num" style="color:#555">' + i + '</div><div class="s-cat" style="color:#444">empty</div>';
    grid.appendChild(card);
  }
}
function setRadio(name, value) {
  if (!value) return;
  var r = Array.from(document.getElementsByName(name)).find(function(x) {
    return x.value === String(value);
  });
  if (r) r.checked = true;
}
function getActiveSelectTitle(listSel) {
  var a = document.querySelector(listSel + " .select-item.active");
  return a ? a.dataset.rawValue || a.title : "";
}
function setActiveSelectByTitle(listSel, title) {
  if (!title) return;
  var items = document.querySelectorAll(listSel + " .select-item");
  for (var i = 0; i < items.length; i++) {
    if ((items[i].dataset.rawValue || items[i].title) === title) {
      items[i].click();
      return;
    }
  }
}
function selectCharByName(name) {
  var items = document.querySelectorAll("#charGrid .char-item");
  for (var i = 0; i < items.length; i++) {
    var en = items[i].querySelector(".en");
    if (en && en.textContent === name) {
      items[i].click();
      return true;
    }
  }
  return false;
}
function collectSessionConfig() {
  var cp = document.getElementById("colorPicker");
  var sm = document.querySelector('input[name="sizeMode"]:checked');
  var cm = document.querySelector('input[name="cameraMode"]:checked');
  var st = document.querySelector('input[name="shoeType"]:checked');
  var shm = document.querySelector('input[name="shoeMode"]:checked');
  return {
    game: currentGame,
    character: selectedChar ? selectedChar.english : "",
    artStyle: getArtStyle(),
    clothingMode: getClothingMode(),
    originalVariant: getSelectedAppearanceIdx(),
    clothingSelect: getActiveSelectTitle("#clothingList"),
    color: cp ? cp.value : "",
    sizeMode: sm ? sm.value : "portrait",
    customWidth: document.getElementById("customWidth").value,
    customHeight: document.getElementById("customHeight").value,
    poseMode: getPoseMode(),
    exprMode: getExprMode(),
    storyStyle,
    storyTone,
    promptLang,
    cameraMode: cm ? cm.value : "random",
    cameraFixed: fixedCamera,
    shotDefault,
    shoeEnabled: document.getElementById("shoeEnabled").checked,
    shoeType: st ? st.value : "shoe",
    shoeMode: shm ? shm.value : "random",
    shoeSelect: getActiveSelectTitle("#shoeList"),
    thighhighColor: document.getElementById("thighhighColor").value,
    personalityEnabled: document.getElementById("personalityEnabled").checked,
    personalityChance: document.getElementById("personalityChance").value,
    sceneCounts: JSON.parse(JSON.stringify(sceneCounts)),
    scenePrompts: JSON.parse(JSON.stringify(scenePrompts)),
    sceneLocations: JSON.parse(JSON.stringify(sceneLocations)),
    lockedColor
  };
}
function applySessionConfig(cfg) {
  if (!cfg) return;
  if (cfg.storyStyle) {
    storyStyle = cfg.storyStyle;
    var sst = Array.from(document.getElementsByName("storyStyle")).find(function(x) {
      return x.value === storyStyle;
    });
    if (sst) sst.checked = true;
  }
  if (cfg.storyTone !== void 0) storyTone = cfg.storyTone || "";
  if (cfg.promptLang) {
    promptLang = cfg.promptLang;
    var plt = Array.from(document.getElementsByName("promptLang")).find(function(x) {
      return x.value === promptLang;
    });
    if (plt) plt.checked = true;
  }
  var toneSel = getToneSelect();
  if (toneSel) {
    toneSel.value = storyTone;
    toneSel.style.display = storyStyle === "manual" ? "" : "none";
  }
  if (cfg.game) {
    var tabs = document.querySelectorAll("#gameTabs .tab-btn");
    for (var i = 0; i < tabs.length; i++) {
      if ((tabs[i].getAttribute("onclick") || "").indexOf("'" + cfg.game + "'") >= 0) {
        switchGame(cfg.game, tabs[i]);
        break;
      }
    }
  }
  if (cfg.character) selectCharByName(cfg.character);
  setRadio("artStyle", cfg.artStyle);
  setRadio("clothingMode", cfg.clothingMode);
  onClothingModeChange();
  if (cfg.originalVariant !== void 0) setOriginalVariant(cfg.originalVariant);
  if (cfg.clothingSelect) setActiveSelectByTitle("#clothingList", cfg.clothingSelect);
  if (cfg.color) {
    var cp = document.getElementById("colorPicker");
    if (cp) cp.value = cfg.color;
  }
  setRadio("sizeMode", cfg.sizeMode);
  onSizeChange();
  if (cfg.customWidth !== void 0) document.getElementById("customWidth").value = cfg.customWidth;
  if (cfg.customHeight !== void 0) document.getElementById("customHeight").value = cfg.customHeight;
  setRadio("poseMode", cfg.poseMode);
  setRadio("exprMode", cfg.exprMode);
  setRadio("cameraMode", cfg.cameraMode === "fixed" ? "fixed" : "random");
  if (cfg.cameraFixed !== void 0) fixedCamera = cfg.cameraFixed;
  if (cfg.shotDefault !== void 0 && document.getElementById("shotDefault")) {
    shotDefault = cfg.shotDefault;
    document.getElementById("shotDefault").value = shotDefault;
  }
  renderCameraOptions();
  onCameraModeChange();
  document.getElementById("shoeEnabled").checked = !!cfg.shoeEnabled;
  setRadio("shoeType", cfg.shoeType);
  setRadio("shoeMode", cfg.shoeMode);
  document.getElementById("shoeTypeRow").style.display = cfg.shoeEnabled ? "block" : "none";
  updateShoeUI();
  if (cfg.shoeSelect) setActiveSelectByTitle("#shoeList", cfg.shoeSelect);
  if (cfg.thighhighColor) document.getElementById("thighhighColor").value = cfg.thighhighColor;
  if (cfg.personalityEnabled !== void 0) document.getElementById("personalityEnabled").checked = !!cfg.personalityEnabled;
  if (cfg.personalityChance !== void 0) document.getElementById("personalityChance").value = cfg.personalityChance;
  if (cfg.sceneCounts) {
    sceneCounts.daytime = Math.max(1, Math.min(16, Math.floor(Number(cfg.sceneCounts.daytime)) || 1));
    sceneCounts.sunset = Math.max(1, Math.min(17 - sceneCounts.daytime, Math.floor(Number(cfg.sceneCounts.sunset)) || 1));
    sceneCounts.night = Math.max(1, Math.min(18 - sceneCounts.daytime - sceneCounts.sunset, Math.floor(Number(cfg.sceneCounts.night)) || 1));
  }
  if (cfg.scenePrompts) scenePrompts = JSON.parse(JSON.stringify(cfg.scenePrompts));
  if (cfg.sceneLocations) sceneLocations = JSON.parse(JSON.stringify(cfg.sceneLocations));
  lockedColor = cfg.lockedColor || null;
  renderLocationConfig();
  syncLocationLabels();
  updateStoryStyleUI();
  renderSceneConfig();
  updateSceneTotal();
  updatePersonalityUI();
}
function catIdxOfPage(page) {
  var order = ["opening", "daytime", "sunset", "night", "confession"];
  var p = page;
  for (var i = 0; i < order.length; i++) {
    var k = order[i];
    var n = k === "opening" || k === "confession" ? 1 : sceneCounts[k] || 1;
    if (p <= n) return { cat: k, idx: p - 1 };
    p -= n;
  }
  return null;
}
function rollScenePrompt(cat, idx) {
  var arr = getScenePool(cat);
  if (!arr || !arr.length) return;
  if (!scenePrompts[cat]) scenePrompts[cat] = [];
  if (arr.length === 1) {
    scenePrompts[cat][idx] = arr[0];
    return;
  }
  var cur = scenePrompts[cat][idx];
  var next = pick(arr), t = 0;
  while (next === cur && t < 12) {
    next = pick(arr);
    t++;
  }
  scenePrompts[cat][idx] = next;
}
function switchGame(gid, btn) {
  document.querySelectorAll("#gameTabs .tab-btn").forEach(function(b) {
    b.classList.remove("active");
  });
  btn.classList.add("active");
  currentGame = gid;
  var grid = document.getElementById("charGrid");
  grid.innerHTML = "";
  selectedChar = null;
  document.getElementById("charInfo").textContent = "Click a character.";
  document.getElementById("appearancePreview").style.display = "none";
  document.getElementById("originalVariantWrap").style.display = "none";
  document.getElementById("personalityRow").style.display = "none";
  Object.keys(CHARS).forEach(function(name) {
    var c = CHARS[name];
    if (c.gameId !== gid) return;
    var el = document.createElement("div");
    el.className = "char-item";
    var en = document.createElement("span");
    en.className = "en";
    en.textContent = name;
    el.appendChild(en);
    if (c.chinese) {
      var cn = document.createElement("span");
      cn.className = "cn";
      cn.textContent = c.chinese;
      el.appendChild(cn);
    }
    el.onclick = function() {
      document.querySelectorAll(".char-item").forEach(function(x) {
        x.classList.remove("selected");
      });
      el.classList.add("selected");
      selectedChar = c;
      selectedChar.english = name;
      document.getElementById("charInfo").textContent = characterName(name) + " · " + tr("Body type:") + " " + c.bodyType;
      var preview = document.getElementById("appearancePreview");
      if (c.appearance_a) {
        preview.textContent = tr("Appearance variant {index}", { index: 1 });
        preview.style.display = "block";
      } else {
        preview.textContent = tr("No appearance available");
        preview.style.display = "block";
      }
      renderOriginalVariants();
      updateAppearancePreview();
      updateClothingHint();
      updatePersonalityUI();
      onStoryContextChange();
    };
    grid.appendChild(el);
  });
  onStoryContextChange();
}
function updatePersonalityUI() {
  var row = document.getElementById("personalityRow");
  if (!selectedChar || !selectedChar.personalityTone) {
    row.style.display = "none";
    return;
  }
  row.style.display = "flex";
  var tone = selectedChar.personalityTone;
  document.getElementById("toneLabel").textContent = tr("Tone:") + " " + tr(tone);
  var tags = PERSONALITY_FACE_TAGS[tone] || [];
  var pack = SCENE_TONES[tone];
  document.getElementById("tagsHint").textContent = tr("{count} personality cues · {story}", { count: tags.length, story: pack ? tr("Story: {name}", { name: tr(pack._label || tone) }) : tr("No dedicated story") });
}
var realStyleAllowed = false;
function applyArtStyleAccess(username) {
  realStyleAllowed = username === "asus";
  var label = document.getElementById("real-style-option");
  if (label) label.hidden = !realStyleAllowed;
  var radio = document.querySelector('input[name="artStyle"][value="real"]');
  if (radio) {
    radio.disabled = !realStyleAllowed;
    if (!realStyleAllowed && radio.checked) {
      radio.checked = false;
      var fallback = document.querySelector('input[name="artStyle"][value="anime_special"]');
      if (fallback) fallback.checked = true;
    }
  }
}
function getArtStyle() {
  var r = document.querySelector('input[name="artStyle"]:checked');
  return r && (r.value !== "real" || realStyleAllowed) ? r.value : "anime_special";
}
function getClothingMode() {
  var r = document.querySelector('input[name="clothingMode"]:checked');
  return r ? r.value : "original";
}
function getAppearanceVariants() {
  var out = [];
  if (!selectedChar) return out;
  ["appearance_a", "appearance_b", "appearance_c", "appearance_d", "appearance_e"].forEach(function(k) {
    var v = selectedChar[k];
    if (v && String(v).trim()) out.push({ key: k, value: String(v).trim() });
  });
  return out;
}
function getSelectedAppearanceIdx() {
  var vs = getAppearanceVariants();
  var sel = document.querySelector('input[name="originalVariant"]:checked');
  var idx = sel ? parseInt(sel.value, 10) : 0;
  if (isNaN(idx) || idx < 0 || idx >= vs.length) idx = 0;
  return idx;
}
function getSelectedAppearance() {
  var vs = getAppearanceVariants();
  if (!vs.length) return "";
  return vs[getSelectedAppearanceIdx()].value;
}
function getSelectedAppearanceKey() {
  var vs = getAppearanceVariants();
  if (!vs.length) return "appearance_a";
  return vs[getSelectedAppearanceIdx()].key;
}
function renderOriginalVariants() {
  var wrap = document.getElementById("originalVariantWrap");
  var box = document.getElementById("originalVariantOptions");
  if (!wrap || !box) return;
  var vs = getAppearanceVariants();
  if (vs.length <= 1) {
    box.innerHTML = "";
    wrap.style.display = "none";
    return;
  }
  var prev = document.querySelector('input[name="originalVariant"]:checked');
  var prevIdx = prev ? parseInt(prev.value, 10) : 0;
  if (isNaN(prevIdx) || prevIdx < 0 || prevIdx >= vs.length) prevIdx = 0;
  var html = "";
  vs.forEach(function(v, idx) {
    html += '<label><input type="radio" name="originalVariant" value="' + idx + '"' + (idx === prevIdx ? " checked" : "") + ' onchange="onOriginalVariantChange()"> Original ' + (idx + 1) + "</label>";
  });
  box.innerHTML = html;
  wrap.style.display = getClothingMode() === "original" ? "block" : "none";
}
function setOriginalVariant(idx) {
  var r = document.querySelector('input[name="originalVariant"][value="' + idx + '"]');
  if (r) {
    r.checked = true;
  }
  updateAppearancePreview();
  updateClothingHint();
}
function onOriginalVariantChange() {
  updateAppearancePreview();
  updateClothingHint();
}
function updateAppearancePreview() {
  var preview = document.getElementById("appearancePreview");
  if (!preview || !selectedChar) return;
  var vs = getAppearanceVariants();
  if (!vs.length) {
    preview.textContent = tr("No appearance available");
    preview.style.display = "block";
    return;
  }
  var i = getSelectedAppearanceIdx();
  preview.textContent = tr("Appearance variant {index}", { index: i + 1 + "/" + vs.length });
  preview.style.display = "block";
}
function updateClothingHint() {
  var hint = document.getElementById("clothingHint");
  if (!hint) return;
  if (getClothingMode() === "original") {
    var vs = getAppearanceVariants();
    hint.textContent = vs.length > 1 ? "All pages use " + getSelectedAppearanceKey() + " (Original " + (getSelectedAppearanceIdx() + 1) + " of " + vs.length + ")" : "All pages use appearance_a";
  } else {
    hint.textContent = "Clothing applied to all pages";
  }
}
function getColor() {
  if (lockedColor) return lockedColor;
  var sel = document.getElementById("colorPicker");
  var val = sel.value;
  if (!val || val === "random") return pick(COLOR_OPTIONS);
  return val;
}
function replaceColor(s, c) {
  return s.replace(/&&color&&/g, c);
}
function onClothingModeChange() {
  var mode = getClothingMode();
  document.getElementById("colorPickerWrap").style.display = mode === "random" || mode === "select" ? "block" : "none";
  document.getElementById("clothingSelectPanel").style.display = mode === "select" ? "block" : "none";
  renderOriginalVariants();
  updateClothingHint();
}
function renderColorPicker() {
  var sel = document.getElementById("colorPicker");
  sel.innerHTML = '<option value="random">Random</option>';
  COLOR_OPTIONS.forEach(function(c) {
    var opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c.charAt(0).toUpperCase() + c.slice(1);
    sel.appendChild(opt);
  });
}
function renderClothingSelectPanel() {
  var list = document.getElementById("clothingList");
  list.innerHTML = "";
  RANDOM_CLOTHING.forEach(function(item, idx) {
    var el = document.createElement("div");
    el.className = "select-item";
    var label = item.replace(/&&color&&/g, "").replace(/_/g, " ").replace(/,$/, "").trim();
    if (label.length > 30) label = label.substring(0, 28) + "...";
    label = optionLabel(item, label);
    el.textContent = label;
    el.dataset.rawValue = item;
    el.title = label;
    el.onclick = function() {
      document.querySelectorAll("#clothingList .select-item").forEach(function(e) {
        e.classList.remove("active");
      });
      el.classList.add("active");
      document.getElementById("clothingSelectedLabel").textContent = tr(label);
    };
    list.appendChild(el);
  });
  document.getElementById("clothingSearch").oninput = function() {
    var q = this.value.toLowerCase();
    list.querySelectorAll(".select-item").forEach(function(e) {
      e.style.display = ((e.dataset.rawValue || "") + " " + e.textContent).toLowerCase().indexOf(q) >= 0 ? "" : "none";
    });
  };
}
var LOC_BY_CAT = { opening: ["regular", "urban"], daytime: ["urban", "outdoor"], sunset: ["outdoor", "fantasy"], night: ["urban", "regular"], confession: ["special", "outdoor", "fantasy"] };
function locPoolByName(n) {
  if (n === "regular") return LO_REGULAR;
  if (n === "outdoor") return LO_OUTDOOR;
  if (n === "urban") return LO_URBAN;
  if (n === "fantasy") return LO_FANTASY;
  if (n === "scifi") return LO_SCIFI;
  if (n === "special") return LO_SPECIAL;
  return [];
}
function locSeed(s) {
  var h = 0;
  for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 997;
  return h;
}
function getLocationPool(cat) {
  var names = LOC_BY_CAT[cat];
  if (names && names.length) {
    var p = [];
    names.forEach(function(n) {
      p = p.concat(locPoolByName(n) || []);
    });
    if (p.length) return p;
  }
  return [].concat(LO_REGULAR, LO_OUTDOOR, LO_URBAN, LO_FANTASY, LO_SCIFI, LO_SPECIAL);
}
function buildLocation(cat, idx) {
  var pool = getLocationPool(cat);
  if (!pool.length) return "";
  var n = typeof idx === "number" ? idx : 0;
  return ec(pool[(n + locSeed(cat || "")) % pool.length]);
}
function getTimeForCat(cat) {
  if (cat === "daytime") return ec(pick(TI.daytime || TI.random || []));
  if (cat === "sunset") return ec(pick(TI.sunset || ["sunset,"]));
  if (cat === "night" || cat === "confession") return ec(pick(TI.night || TI.random || []));
  return ec(pick(TI.daytime || TI.random || []));
}
function renderShoeSection() {
  document.getElementById("shoeEnabled").addEventListener("change", function() {
    document.getElementById("shoeTypeRow").style.display = this.checked ? "block" : "none";
    updateShoeUI();
  });
  document.querySelectorAll('input[name="shoeType"]').forEach(function(r) {
    r.addEventListener("change", updateShoeUI);
  });
  document.querySelectorAll('input[name="shoeMode"]').forEach(function(r) {
    r.addEventListener("change", function() {
      document.getElementById("shoeSelectPanel").style.display = r.value === "select" ? "block" : "none";
    });
  });
  renderShoeSelectPanel();
}
function updateShoeUI() {
  var enabled = document.getElementById("shoeEnabled").checked;
  var type = document.querySelector('input[name="shoeType"]:checked').value;
  if (!enabled) {
    document.getElementById("shoeModeRow").style.display = "none";
    document.getElementById("shoeSelectPanel").style.display = "none";
    document.getElementById("thighhighColorRow").style.display = "none";
    return;
  }
  if (type === "shoe") {
    document.getElementById("shoeModeRow").style.display = "block";
    document.getElementById("shoeSelectPanel").style.display = document.querySelector('input[name="shoeMode"]:checked').value === "select" ? "block" : "none";
    document.getElementById("thighhighColorRow").style.display = "none";
  } else if (type === "pantyhose") {
    document.getElementById("shoeModeRow").style.display = "none";
    document.getElementById("shoeSelectPanel").style.display = "none";
    document.getElementById("thighhighColorRow").style.display = "none";
  } else {
    document.getElementById("shoeModeRow").style.display = "none";
    document.getElementById("shoeSelectPanel").style.display = "none";
    document.getElementById("thighhighColorRow").style.display = "block";
  }
}
function renderShoeSelectPanel() {
  var list = document.getElementById("shoeList");
  list.innerHTML = "";
  RANDOM_SHOES.forEach(function(item, idx) {
    var el = document.createElement("div");
    el.className = "select-item";
    var label = item.replace(/_/g, " ").replace(/,$/, "").trim();
    if (label.length > 30) label = label.substring(0, 28) + "...";
    label = optionLabel(item, label);
    el.textContent = label;
    el.dataset.rawValue = item;
    el.title = label;
    el.onclick = function() {
      list.querySelectorAll(".select-item").forEach(function(e) {
        e.classList.remove("active");
      });
      el.classList.add("active");
      document.getElementById("shoeSelectedLabel").textContent = tr(label);
    };
    list.appendChild(el);
  });
  document.getElementById("shoeSearch").oninput = function() {
    var q = this.value.toLowerCase();
    list.querySelectorAll(".select-item").forEach(function(e) {
      e.style.display = ((e.dataset.rawValue || "") + " " + e.textContent).toLowerCase().indexOf(q) >= 0 ? "" : "none";
    });
  };
}
function buildShoeText() {
  if (!document.getElementById("shoeEnabled").checked) return "";
  var type = document.querySelector('input[name="shoeType"]:checked').value;
  if (type === "pantyhose") return "pantyhose,";
  if (type === "thighhigh") return document.getElementById("thighhighColor").value + "_thighhighs,";
  var mode = document.querySelector('input[name="shoeMode"]:checked').value;
  if (mode === "select") {
    var active = document.querySelector("#shoeList .select-item.active");
    if (active) {
      var idx = Array.from(active.parentNode.children).indexOf(active);
      if (idx >= 0 && RANDOM_SHOES[idx]) return RANDOM_SHOES[idx];
    }
  }
  return pick(RANDOM_SHOES) || "";
}
function buildClothing() {
  var mode = getClothingMode();
  if (mode === "original") return selectedChar ? getSelectedAppearance() : "";
  if (mode === "select") {
    var active = document.querySelector("#clothingList .select-item.active");
    if (active) {
      var idx = Array.from(active.parentNode.children).indexOf(active);
      if (idx >= 0 && RANDOM_CLOTHING[idx]) return ec(replaceColor(RANDOM_CLOTHING[idx], getColor()));
    }
    return "";
  }
  return ec(replaceColor(pick(RANDOM_CLOTHING), getColor()));
}
function onSizeChange() {
  var mode = document.querySelector('input[name="sizeMode"]:checked').value;
  document.getElementById("customSizeRow").style.display = mode === "custom" ? "block" : "none";
}
function getImageSize() {
  var mode = document.querySelector('input[name="sizeMode"]:checked').value;
  if (mode === "portrait") return { width: 768, height: 1408 };
  if (mode === "landscape") return { width: 1366, height: 768 };
  if (mode === "square") return { width: 768, height: 768 };
  return { width: parseInt(document.getElementById("customWidth").value) || 768, height: parseInt(document.getElementById("customHeight").value) || 1408 };
}
function renderCameraOptions() {
  var sel = document.getElementById("fixedCameraSelect");
  if (!sel) return;
  sel.innerHTML = "";
  if (!CAMERAS || !CAMERAS.length) {
    sel.innerHTML = '<option value="">(no camera pool)</option>';
    return;
  }
  CAMERAS.forEach(function(c) {
    var o = document.createElement("option");
    o.value = c;
    o.textContent = String(c).replace(/,$/, "").trim();
    sel.appendChild(o);
  });
  if (fixedCamera) sel.value = fixedCamera;
  if (!fixedCamera) fixedCamera = CAMERAS[0];
  if (sel.value) fixedCamera = sel.value;
}
function onCameraModeChange() {
  var r = document.querySelector('input[name="cameraMode"]:checked');
  var mode = r ? r.value : "random";
  var row = document.getElementById("fixedCameraRow");
  if (row) row.style.display = mode === "fixed" ? "block" : "none";
  if (mode === "fixed") {
    var sel = document.getElementById("fixedCameraSelect");
    if (sel && !sel.options.length) renderCameraOptions();
    if (!fixedCamera && CAMERAS && CAMERAS.length) fixedCamera = CAMERAS[0];
    if (sel && fixedCamera) sel.value = fixedCamera;
    onFixedCameraChange();
  }
}
function onFixedCameraChange() {
  var sel = document.getElementById("fixedCameraSelect");
  if (sel && sel.value) fixedCamera = sel.value;
}
var NL_SHOT = {
  "full body": "The framing keeps her whole body in view, from head to toe.",
  "cowboy shot": "The framing shows her from the knees up.",
  "upper body": "The framing shows her upper body.",
  "close-up": "The frame is a close-up on her."
};
function hasShotTag(s) {
  s = String(s || "");
  if (/(^|,)\s*(full body|cowboy shot|upper body|close-up)\s*(,|$)/.test(s)) return true;
  return /close-?up|only her face|from the waist up|upper body/i.test(s);
}
function getShotTag(sceneSrc) {
  if (hasShotTag(sceneSrc)) return "";
  var sel = document.getElementById("shotDefault");
  var v = sel ? sel.value : shotDefault;
  if (!v) return "";
  if (promptLang === "nl") return NL_SHOT[v] || "";
  return ec(v);
}
function onShotDefaultChange() {
  var sel = document.getElementById("shotDefault");
  if (sel) shotDefault = sel.value;
}
function getCameraTag() {
  var r = document.querySelector('input[name="cameraMode"]:checked');
  var mode = r ? r.value : "random";
  if (mode === "fixed") return ec(fixedCamera || CAMERAS[0] || "");
  return ec(pick(CAMERAS));
}
function getPersonalityTags() {
  if (!document.getElementById("personalityEnabled").checked) return "";
  if (!selectedChar || !selectedChar.personalityTone) return "";
  var chance = parseInt(document.getElementById("personalityChance").value) || 50;
  if (Math.random() * 100 >= chance) return "";
  var tone = selectedChar.personalityTone;
  var tags = PERSONALITY_FACE_TAGS[tone] || [];
  if (!tags.length) return "";
  if (tone === "android") return "expressionless," + (Math.random() < 0.5 ? pick(tags) : "");
  return pick(tags);
}
function dedupPrompt(s) {
  if (!s) return s;
  var hasTrailing = s.trim().endsWith(",");
  var tags = s.split(",").map(function(t) {
    return t.trim();
  }).filter(function(t) {
    return t;
  });
  function base(tag) {
    var m = tag.match(/^\((.+?):[\d.]+\)$/);
    return m ? m[1].toLowerCase().replace(/\s+/g, "_") : tag.toLowerCase().replace(/\s+/g, "_");
  }
  var groups = {};
  tags.forEach(function(tag) {
    var b = base(tag);
    if (!groups[b]) groups[b] = [];
    groups[b].push(tag);
  });
  var result = [];
  Object.keys(groups).forEach(function(b) {
    var items = groups[b];
    if (items.length > 1) {
      var best = items[0];
      for (var i = 0; i < items.length; i++) {
        if (/^\(.+:[\d.]+\)$/.test(items[i])) {
          best = items[i];
          break;
        }
      }
      result.push(best);
    } else {
      result.push(items[0]);
    }
  });
  var out = result.join(",");
  if (hasTrailing && !out.endsWith(",")) out += ",";
  return out;
}
function getPoseMode() {
  var r = document.querySelector('input[name="poseMode"]:checked');
  return r ? r.value : "fixed";
}
function getExprMode() {
  var r = document.querySelector('input[name="exprMode"]:checked');
  return r ? r.value : "fixed";
}
function onPoseModeChange() {
}
function onExprModeChange() {
}
function _wch(c) {
  return c >= "a" && c <= "z" || c >= "0" && c <= "9" || c === "_";
}
function _hasWord(hay, needle) {
  if (!needle) return false;
  var from = 0, i;
  while ((i = hay.indexOf(needle, from)) >= 0) {
    var b = i === 0 || !_wch(hay.charAt(i - 1)) || !_wch(needle.charAt(0));
    var e = i + needle.length >= hay.length || !_wch(hay.charAt(i + needle.length)) || !_wch(needle.charAt(needle.length - 1));
    if (b && e) return true;
    from = i + 1;
  }
  return false;
}
function parseScenePrompt(text) {
  if (!text) return { action: "", expression: "" };
  var parts = text.split(",").map(function(s) {
    return s.trim();
  }).filter(function(s) {
    return s;
  });
  var exprWords = [
    "smile",
    "open mouth",
    "parted lips",
    "serious",
    "relax",
    "embarrassed",
    "pouty_lips",
    "chestnut_mouth",
    "wink",
    "nose_blush",
    "sad",
    "angry",
    "crying",
    "tears",
    "grin",
    "smirk",
    "surprised",
    "shocked",
    "confused",
    "scared",
    "disgusted",
    "pain",
    "tongue out",
    "biting lip",
    "whistling",
    "sigh",
    "yawn",
    "gasp",
    "frown",
    "grimace",
    "sneer",
    "pout",
    "scowl",
    "glare",
    "stare",
    "looking away",
    "looking up",
    "looking down",
    "looking at viewer",
    "closed eyes",
    "half-closed eyes",
    "wide eyes",
    "heart-shaped pupils",
    "spiral eyes",
    "x_x",
    ">_<",
    "^_^",
    "_=_",
    "o_o",
    "T_T",
    "Orz",
    "d:,_face",
    "blush",
    "nose blush",
    "happy",
    "gentle smile",
    "soft smile",
    "slight smile",
    "content smile",
    "shy smile",
    "nervous smile",
    "hopeful smile",
    "relaxed smile",
    "confident smile",
    "eyes closed",
    "looking at sky",
    "looking at water",
    "looking at viewer",
    "comfortable silence",
    "tears of joy",
    "pleading",
    "nervous",
    "lip",
    "lips parted",
    "smug",
    "disdain",
    "condescending",
    "aloof",
    "flustered",
    "annoyed",
    "anger vein",
    "expressionless",
    "bored",
    "staring",
    "stare",
    "pensive",
    "determined",
    "thinking",
    "wide-eyed",
    "one eye closed",
    "calm",
    "neutral face",
    "blinking",
    "crazy",
    "naughty face",
    "doyagao",
    "full-face blush",
    "blushing",
    "worried",
    "timid",
    "timid smile",
    "pouting",
    "huffing",
    "raised eyebrow",
    "sighing",
    "laughing",
    "thoughtful",
    "focused",
    "excited",
    "round mouth"
  ];
  var action = [];
  var expression = [];
  parts.forEach(function(p) {
    var isExpr = false;
    for (var i = 0; i < exprWords.length; i++) {
      if (_hasWord(p.toLowerCase(), exprWords[i].toLowerCase())) {
        isExpr = true;
        break;
      }
    }
    if (isExpr) expression.push(p);
    else action.push(p);
  });
  return { action: action.join(", "), expression: expression.join(", ") };
}
function buildSceneTextB(cat, sceneIdx) {
  var t = "";
  var shotSrc = scenePrompts[cat] && scenePrompts[cat][sceneIdx] || "";
  t += getShotTag(shotSrc);
  t += getCameraTag();
  var poseMode = getPoseMode();
  var exprMode = getExprMode();
  if (poseMode === "fixed") {
    var prompt = scenePrompts[cat] && scenePrompts[cat][sceneIdx] || "";
    var parsed = parseScenePrompt(prompt);
    t += ec(promptLang === "nl" ? prompt.replace(/\.\s*$/, "") : parsed.action);
  } else {
    t += ec(pick(POSES));
  }
  if (sceneLocations[cat]) {
    t += ec(sceneLocations[cat]);
  } else {
    t += buildLocation(cat, sceneIdx);
  }
  t += getTimeForCat(cat);
  t += buildClothing();
  t += buildShoeText();
  if (poseMode === "fixed") {
    var prompt2 = scenePrompts[cat] && scenePrompts[cat][sceneIdx] || "";
    var parsed2 = parseScenePrompt(prompt2);
    if (exprMode === "fixed" && promptLang !== "nl") {
      t += ec(parsed2.expression);
    }
  }
  if (promptLang !== "nl" && exprMode === "random") {
    t += ec(pick(EXPRESSIONS));
  }
  if (promptLang !== "nl") t += ec(pick(EM));
  if (promptLang !== "nl" && Math.random() < 0.3) t += ec(pick(HAND_GESTURES));
  t += ec(pick(LIGHTING));
  if (promptLang !== "nl") RA.forEach(function(line) {
    var m = line.match(/^(\d+\.?\d*)\s*:\s*(.+)$/);
    if (m && Math.random() < parseFloat(m[1])) t += ec(m[2]);
  });
  return dedupPrompt(t);
}
function tr(key, values) {
  var text = typeof window !== "undefined" && window.uiLocale ? window.uiLocale.t(key, key) : key;
  if (values) Object.keys(values).forEach(function(k) {
    text = text.replaceAll("{" + k + "}", typeof values[k] === "string" ? tr(values[k]) : String(values[k]));
  });
  return text;
}
function optionLabel(raw, fallback) {
  var label = tr(raw, tr(fallback || raw)).replace(/&&color&&/g, "").replace(/_/g, " ");
  COLOR_OPTIONS.forEach(function(color) {
    var escaped = color.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    label = label.replace(new RegExp("\\b" + escaped + "\\b", "gi"), "");
    var translated = tr(color);
    if (translated !== color) label = label.split(translated).join("");
  });
  return label.replace(/(?:黑色|白色|橙色|红色|蓝色|绿色|黄色|紫色|粉色|棕色|灰色|银色|金色|米色|天蓝色|深蓝色|浅蓝色)/g, "").replace(/^[\s·、,]+|[\s·、,]+$/g, "").replace(/\s+/g, " ").trim();
}
function characterName(name) {
  return typeof window !== "undefined" && window.uiLocale ? window.uiLocale.translateCharacter(name) : name;
}
function describePrompt(text, category) {
  var _a;
  return typeof window !== "undefined" && window.promptDisplay ? window.promptDisplay.describe(text, category, ((_a = window.uiLocale) == null ? void 0 : _a.language) || "en") : text;
}
function showPreview() {
  var out = [], num = 1;
  ["opening", "daytime", "sunset", "night", "confession"].forEach(function(cat) {
    var _a;
    var count = cat === "opening" || cat === "confession" ? 1 : sceneCounts[cat];
    for (var i = 0; i < count; i++) {
      out.push(tr("Scene {page}: {category}", { page: num++, category: tr(cat.charAt(0).toUpperCase() + cat.slice(1)) }) + "\n" + describePrompt(((_a = scenePrompts[cat]) == null ? void 0 : _a[i]) || "", cat));
    }
  });
  var box = document.getElementById("previewBox");
  box.textContent = out.join("\n\n");
  box.classList.add("show");
  previewVisible = true;
}
var previewVisible = false, lastStatus = null;
function showStatus(msg, type, values) {
  lastStatus = { msg, type, values };
  var bar = document.getElementById("statusBar");
  bar.style.display = "block";
  bar.className = "status status-" + type;
  bar.textContent = tr(msg, values);
}
function redrawLanguage() {
  var _a;
  renderServerStatus();
  updateBalance();
  if (document.body.hidden) return;
  renderSceneConfig();
  renderSlots();
  syncLocationLabels();
  updatePersonalityUI();
  updateStoryStyleUI();
  var clothing = getActiveSelectTitle("#clothingList"), shoe = getActiveSelectTitle("#shoeList"), color = document.getElementById("colorPicker").value;
  renderCameraOptions();
  renderColorPicker();
  document.getElementById("colorPicker").value = color;
  renderClothingSelectPanel();
  renderShoeSelectPanel();
  setActiveSelectByTitle("#clothingList", clothing);
  setActiveSelectByTitle("#shoeList", shoe);
  if (selectedChar) {
    document.getElementById("charInfo").textContent = characterName(selectedChar.english) + " · " + tr("Body type:") + " " + selectedChar.bodyType;
    updateAppearancePreview();
  }
  if (previewVisible) showPreview();
  if (lastStatus) showStatus(lastStatus.msg, lastStatus.type, lastStatus.values);
  updateActionButtons();
  if (typeof window !== "undefined") (_a = window.uiLocale) == null ? void 0 : _a.applyTranslations();
}
function hideStatus() {
  document.getElementById("statusBar").style.display = "none";
}
const TOKEN_KEY = "dateher_token";
const PENDING_KEY = "dateher_pending";
let requestOnly = false, creditPolicyState = { enabled: false }, accountBalance = null;
function updateBalance(value = accountBalance) {
  var _a, _b;
  accountBalance = value;
  const el = document.getElementById("accountBalance");
  if (el) {
    el.hidden = value === null;
    el.textContent = value === null ? "" : (((_a = window.uiLocale) == null ? void 0 : _a.language) === "zh-cn" ? "账户余额：" : "Balance: ") + value + (((_b = window.uiLocale) == null ? void 0 : _b.language) === "zh-cn" ? " 分" : " points");
  }
}
const downloadAuthorizations = /* @__PURE__ */ new Map();
let knownJobs = [], refreshBusy = false, submitBusy = false, selectionVersion = 0, loggedOut = false, serverHasImages = false;
let pending = null;
try {
  pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) || "null");
  if (pending && (!Array.isArray(pending.requests) || !pending.requests.length || pending.requests.length > 20 || !Number.isInteger(pending.next) || pending.next < 0 || pending.next > pending.requests.length)) pending = null;
} catch (e) {
  sessionStorage.removeItem(PENDING_KEY);
}
const regenPending = /* @__PURE__ */ new Map(), actionCooldown = /* @__PURE__ */ new Map();
const COOLDOWN_MS = 700;
const BATCH_LOAD_COOLDOWN_MS = 3e4, BATCH_LOAD_KEY = "dateher_batch_load_time";
try {
  const saved = Number(sessionStorage.getItem(BATCH_LOAD_KEY));
  if (saved > 0) actionCooldown.set("batchLoad", saved);
} catch (e) {
}
function startBatchLoad() {
  const now = Date.now();
  actionCooldown.set("batchLoad", now);
  try {
    sessionStorage.setItem(BATCH_LOAD_KEY, String(now));
  } catch (e) {
  }
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function actionBlocked(key, busy) {
  if (loggedOut) return true;
  if (busy) {
    showStatus("An action is already running. Please wait.", "err");
    return true;
  }
  if (key === "submit" || key === "refresh") {
    const last = actionCooldown.get("batchLoad");
    const remaining = last === void 0 ? 0 : BATCH_LOAD_COOLDOWN_MS - (Date.now() - last);
    if (remaining > 0) {
      showStatus("Batch submission and image loading share a 30-second cooldown. Please wait {seconds} seconds.", "err", { seconds: Math.ceil(remaining / 1e3) });
      return true;
    }
  }
  if (Date.now() - (actionCooldown.get(key) || 0) < COOLDOWN_MS) {
    showStatus("Please wait a moment before trying again.", "err");
    return true;
  }
  return false;
}
function finishAction(key) {
  actionCooldown.set(key, Date.now());
  updateActionButtons();
  if (key === "submit" || key === "refresh") void refreshServerStatus();
}
let serverSnapshot = null, serverStatusBusy = false;
function renderServerStatus() {
  var _a;
  const el = document.getElementById("serverStatus");
  if (!el) return;
  const zh = ((_a = window.uiLocale) == null ? void 0 : _a.language) === "zh-cn", s = serverSnapshot;
  if (!s) {
    el.textContent = zh ? "服务器状态：未知" : "Server status: unknown";
    return;
  }
  const fresh = s.reported_at && Date.now() - s.reported_at < 3e5;
  const online = !!s.online && fresh;
  const time = s.reported_at ? new Date(s.reported_at).toLocaleTimeString(zh ? "zh-CN" : "en-US") : "—";
  el.textContent = (zh ? "服务器：" : "Server: ") + (online ? zh ? "在线" : "Online" : zh ? "离线" : "Offline") + " · " + (zh ? "等待：" : "Waiting: ") + (fresh && s.waiting !== null ? s.waiting : "—") + " · " + (zh ? "生成中：" : "Running: ") + (fresh && s.running !== null ? s.running : "—") + " · " + (zh ? "上次报告：" : "Last report: ") + time;
}
async function refreshServerStatus() {
  if (loggedOut || serverStatusBusy || !document.getElementById("serverStatus")) return;
  serverStatusBusy = true;
  try {
    const data = await jsonApi("/api/status");
    if (!loggedOut) {
      serverSnapshot = data.server || null;
      renderServerStatus();
    }
  } catch (e) {
    if (!loggedOut) {
      serverSnapshot = null;
      renderServerStatus();
    }
  } finally {
    serverStatusBusy = false;
  }
}
function updateActionButtons() {
  for (const [id, busy, key] of [["submitBtn", submitBusy, submitBusy ? "Submitting…" : pending ? "Retry submission" : "Submit"], ["refreshBtn", refreshBusy, refreshBusy ? "Loading…" : "Refresh"]]) {
    const button = document.getElementById(id);
    if (button) {
      button.textContent = tr(key);
      button.setAttribute("aria-busy", String(busy));
    }
  }
}
async function api(path, options = {}) {
  if (loggedOut && path !== "/api/auth/logout") throw new Error("Please log in");
  const response = await bootFetch(path, { ...options, headers: { Authorization: "Bearer " + sessionStorage.getItem(TOKEN_KEY), ...options.body ? { "Content-Type": "application/json" } : {}, ...options.headers }, cache: "no-store" });
  if (loggedOut && path !== "/api/auth/logout") throw new Error("Please log in");
  if (response.status === 401) {
    resetSession();
    sessionStorage.removeItem(TOKEN_KEY);
    location.replace("/");
    throw new Error("Please log in");
  }
  if (!response.ok) {
    let message = "Request failed";
    try {
      const d = await response.json();
      message = d.error || d.message || message;
    } catch (e) {
    }
    const error = new Error(String(message));
    error.status = response.status;
    throw error;
  }
  return response;
}
async function jsonApi(path, options) {
  const data = await (await api(path, options)).json();
  if ("balance" in data) updateBalance(data.balance);
  if (loggedOut && path !== "/api/auth/logout") throw new Error("Please log in");
  return data;
}
function randomSeed() {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}
function replacementSeed(previous) {
  const seed = randomSeed();
  return seed === previous ? (seed + 1) % 4294967296 : seed;
}
function rememberPending() {
  if (pending) sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  else sessionStorage.removeItem(PENDING_KEY);
}
function groupJobs() {
  var _a;
  const groups = /* @__PURE__ */ new Map();
  for (const job of knownJobs) {
    const id = (_a = job.parameters) == null ? void 0 : _a.session_id;
    if (typeof id === "string") {
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(job);
    }
  }
  return groups;
}
function clearImages() {
  for (const img of Object.values(sessionImages)) URL.revokeObjectURL(img.url);
  sessionImages = {};
}
function imageReady(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => resolve({ url, width: img.naturalWidth, height: img.naturalHeight, blob });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Image could not be decoded"));
    };
    img.src = url;
  });
}
function acceptSession(data) {
  creditPolicyState = data.credit_policy || { enabled: false };
  if ("balance" in data) updateBalance(data.balance);
  const changed = currentSession !== (data.session_id || "");
  if (changed) {
    selectionVersion++;
    clearImages();
    regenPending.clear();
  }
  requestOnly = !!data.request_only;
  currentSession = data.session_id || "";
  knownJobs = data.jobs || [];
  serverHasImages = !!data.has_images;
  if (data.config) applySessionConfig(data.config);
  renderSlots();
}
async function loadKnownPreviews(version, session) {
  var _a, _b, _c, _d, _e, _f, _g;
  const jobs = groupJobs().get(session) || [];
  const pages = /* @__PURE__ */ new Map();
  for (const job of jobs) {
    const page = Number((_a = job.parameters) == null ? void 0 : _a.page_index);
    if (page >= 1 && page <= 20 && Number.isInteger(page) && ["succeeded", "completed"].includes(job.status)) {
      const old = pages.get(page);
      if (!old || Number(job.created_at) > Number(old.created_at) || String(job.created_at) > String(old.created_at)) pages.set(page, job);
    }
  }
  let failures = 0;
  for (const [page, job] of pages) {
    if (version !== selectionVersion) break;
    if (((_b = sessionImages[page]) == null ? void 0 : _b.jobId) === job.id) continue;
    try {
      if (!/^[0-9a-f-]{36}$/i.test(job.id)) throw new Error("Invalid task ID");
      const detail = await jsonApi("/api/jobs/" + job.id);
      const item = detail.job || detail;
      const result = (_c = item.results) == null ? void 0 : _c[0];
      if (!result) continue;
      const index = Number((_e = (_d = result.index) != null ? _d : result.result_index) != null ? _e : 0);
      if (!Number.isInteger(index) || index < 0) throw new Error("Invalid image index");
      const response = await api("/api/jobs/" + job.id + "/results/" + index);
      const blob = await response.blob();
      if (!/^image\/(png|jpeg|webp)$/.test(blob.type)) throw new Error("Unsupported image type");
      const loaded = await imageReady(blob);
      const originalWidth = Number((_f = response.headers) == null ? void 0 : _f.get("X-Original-Width")), originalHeight = Number((_g = response.headers) == null ? void 0 : _g.get("X-Original-Height"));
      if (originalWidth > 0 && originalHeight > 0) {
        loaded.width = originalWidth;
        loaded.height = originalHeight;
      }
      if (version !== selectionVersion) {
        URL.revokeObjectURL(loaded.url);
        break;
      }
      const old = sessionImages[page];
      sessionImages[page] = { ...loaded, jobId: job.id, resultIndex: index, parameters: structuredClone(job.parameters) };
      if (old) URL.revokeObjectURL(old.url);
      renderSlots();
    } catch (error) {
      failures++;
      showStatus("Image unavailable: {error}", "err", { error: error.message });
    }
  }
  if (version === selectionVersion) showStatus(failures ? "Loaded {count} pages; {failures} images unavailable. Refresh manually to retry." : "Loaded {count} pages. Refresh manually for new results.", failures ? "err" : "ok", { count: Object.keys(sessionImages).length, failures });
}
async function restoreLastImages() {
  if (!currentSession || loggedOut) return;
  refreshBusy = true;
  updateActionButtons();
  const version = selectionVersion, session = currentSession;
  try {
    const last = actionCooldown.get("batchLoad");
    const canLoad = last === void 0 || Date.now() - last >= BATCH_LOAD_COOLDOWN_MS;
    const pendingResults = knownJobs.some((job) => {
      var _a;
      return job.status === "running" && ((_a = job.parameters) == null ? void 0 : _a.session_id) === session;
    });
    if (requestOnly && canLoad && pendingResults) {
      startBatchLoad();
      try {
        const data = await jsonApi("/api/session?load=1");
        if (version !== selectionVersion) return;
        acceptSession(data);
        if (currentSession !== session) return;
      } catch (error) {
        if (loggedOut) return;
        showStatus(error.message, "err");
      }
    }
    if (version === selectionVersion) await loadKnownPreviews(version, session);
  } finally {
    refreshBusy = false;
    updateActionButtons();
  }
}
async function refreshSessions() {
  if (actionBlocked("refresh", refreshBusy || submitBusy || [...regenPending.values()].some((e) => e.busy))) return;
  refreshBusy = true;
  updateActionButtons();
  const version = selectionVersion;
  const session = currentSession;
  try {
    startBatchLoad();
    const data = await jsonApi("/api/session?load=1");
    if (version !== selectionVersion) return;
    if ((data.session_id || "") !== session) {
      acceptSession(data);
      showStatus("Current batch changed. Click Refresh to load its images.", "ok");
      return;
    }
    knownJobs = data.jobs || [];
    serverHasImages = !!data.has_images;
    await loadKnownPreviews(version, session);
  } catch (error) {
    showStatus(error.message, "err");
  } finally {
    refreshBusy = false;
    finishAction("refresh");
  }
}
async function sendPayload(payload) {
  const data = await jsonApi("/api/jobs", { method: "POST", body: JSON.stringify(payload) });
  if (data.job) {
    knownJobs = knownJobs.filter((j) => j.id !== data.job.id);
    knownJobs.unshift(data.job);
  }
  return data;
}
async function submitAll() {
  if (actionBlocked("submit", submitBusy || refreshBusy || [...regenPending.values()].some((e) => e.busy))) return;
  if (!pending && !selectedChar) {
    showStatus("Please select a character first.", "err");
    return;
  }
  if (!pending && getUsedScenes() > 20) {
    showStatus("Maximum 20 pages.", "err");
    return;
  }
  submitBusy = true;
  updateActionButtons();
  try {
    if (!pending) {
      const active = await jsonApi("/api/session");
      requestOnly = !!active.request_only;
      const hasImages = active.has_images || Object.keys(sessionImages).length > 0;
      if (hasImages && !window.confirm(tr("Start a new batch? Current images will be cleared only after the server accepts it."))) {
        showStatus("Submission cancelled. Current images are unchanged.", "ok");
        return;
      }
      lockedColor = null;
      lockedColor = getColor();
      const size = getImageSize();
      const session = crypto.randomUUID();
      const config = collectSessionConfig();
      const requests = [];
      for (let page = 1; page <= getUsedScenes(); page++) {
        const pos = catIdxOfPage(page);
        requests.push({ request_id: crypto.randomUUID(), workflow_id: "dateher_full", parameters: { positive: buildSceneTextB(pos.cat, pos.idx), width: size.width, height: size.height, seed: randomSeed(), character: selectedChar.english, art_style: getArtStyle(), shot: document.getElementById("shotDefault").value, personality_tags: getPersonalityTags(), session_id: session, page_index: page, session_config: structuredClone(config) } });
      }
      pending = { session, sessionRequest: { request_id: crypto.randomUUID(), session_id: session, config: structuredClone(config), replace: !!active.session_id }, sessionAccepted: false, requests, next: 0 };
      rememberPending();
    }
    if (!pending.sessionRequest) {
      pending.sessionRequest = { request_id: crypto.randomUUID(), session_id: pending.session, config: structuredClone(pending.requests[0].parameters.session_config), replace: true };
      pending.sessionAccepted = false;
      rememberPending();
    }
    if (creditPolicyState.enabled) await jsonApi("/api/credits/quote", { method: "POST", body: JSON.stringify({ request_ids: pending.requests.map((r) => r.request_id) }) });
    startBatchLoad();
    if (!pending.sessionAccepted) {
      const data = await jsonApi("/api/session", { method: "POST", body: JSON.stringify(pending.sessionRequest) });
      if (data.session_id !== pending.session) throw new Error("Batch was replaced elsewhere. Reload before submitting.");
      pending.sessionAccepted = true;
      rememberPending();
      acceptSession(data);
    }
    if (requestOnly) {
      await jsonApi("/api/jobs/batch", { method: "POST", body: JSON.stringify({ requests: pending.requests.slice(pending.next) }) });
      pending.next = pending.requests.length;
      rememberPending();
    } else {
      while (pending.next < pending.requests.length) {
        showStatus("Submitting page {page}/{total}", "ok", { page: pending.next + 1, total: pending.requests.length });
        await sendPayload(pending.requests[pending.next]);
        pending.next++;
        rememberPending();
      }
    }
    pending = null;
    rememberPending();
    showStatus("Pages queued. Click Refresh to load completed images.", "ok");
  } catch (error) {
    if (!loggedOut) showStatus("{error} — Submit again to retry the same IDs and seeds.", "err", { error: error.message });
  } finally {
    submitBusy = false;
    finishAction("submit");
    renderSlots();
  }
}
async function regenOne(page) {
  const image = sessionImages[page];
  const key = currentSession + ":" + page;
  if (!image) {
    showStatus("Load this image with Refresh before regenerating.", "err");
    return;
  }
  if (actionBlocked("regen:" + key, submitBusy || refreshBusy || [...regenPending.values()].some((e) => e.busy))) return;
  if (image.parameters.session_id !== currentSession) {
    showStatus("Batch was replaced elsewhere. Reload before submitting.", "err");
    return;
  }
  let entry = regenPending.get(key);
  if (!entry) {
    entry = { payload: { request_id: crypto.randomUUID(), workflow_id: "dateher_full", parameters: { ...structuredClone(image.parameters), seed: replacementSeed(image.parameters.seed) } }, busy: false };
    regenPending.set(key, entry);
  }
  entry.busy = true;
  renderSlots();
  try {
    await sendPayload(entry.payload);
    regenPending.delete(key);
    showStatus("Page {page} queued. Original stays visible until Refresh loads its replacement.", "ok", { page });
  } catch (error) {
    if (!loggedOut) showStatus("{error} — Regenerate again to retry the same request.", "err", { error: error.message });
  } finally {
    entry.busy = false;
    finishAction("regen:" + key);
    renderSlots();
  }
}
function saveImage(page, original) {
  const image = original || sessionImages[page];
  if (loggedOut || !image) return;
  const url = URL.createObjectURL(image.blob), link = document.createElement("a");
  const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[image.blob.type] || "jpg";
  link.href = url;
  link.download = "date_page_" + page + "." + extension;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 6e4);
}
function downloadImage(page) {
  if (!creditPolicyState.enabled) {
    saveImage(page);
    return;
  }
  const image = sessionImages[page];
  if (!image || loggedOut) return;
  const key = image.jobId + ":" + (image.resultIndex || 0);
  let attempt = downloadAuthorizations.get(key);
  if (attempt == null ? void 0 : attempt.busy) return;
  if (!attempt) {
    attempt = { request_id: crypto.randomUUID(), busy: false };
    downloadAuthorizations.set(key, attempt);
  }
  attempt.busy = true;
  return api("/api/jobs/" + image.jobId + "/download/" + (image.resultIndex || 0), { method: "POST", body: JSON.stringify({ request_id: attempt.request_id }) }).then(async (response) => {
    const balance = response.headers.get("X-Account-Balance");
    if (balance !== null && balance !== "") updateBalance(Number(balance));
    const blob = await response.blob();
    if (!/^image\/(png|jpeg|webp)$/.test(blob.type)) throw new Error("Unsupported image type");
    if (loggedOut) return;
    saveImage(page, { blob });
    downloadAuthorizations.delete(key);
  }).catch(async (error) => {
    showStatus(error.message, "err");
    try {
      const data = await jsonApi("/api/credits");
      updateBalance(data.balance);
    } catch (e) {
    }
  }).finally(() => {
    attempt.busy = false;
    void refreshServerStatus();
  });
}
function downloadAll() {
  Object.keys(sessionImages).forEach(downloadImage);
}
function resetSession() {
  loggedOut = true;
  downloadAuthorizations.clear();
  accountBalance = null;
  selectionVersion++;
  regenPending.clear();
  pending = null;
  knownJobs = [];
  clearImages();
  sessionStorage.removeItem(PENDING_KEY);
  document.body.hidden = true;
}
async function logout() {
  resetSession();
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch (e) {
  } finally {
    clearImages();
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(PENDING_KEY);
    location.replace("/");
  }
}
async function initialize() {
  var _a, _b, _c, _d, _e;
  if (!sessionStorage.getItem(TOKEN_KEY)) {
    location.replace("/");
    return;
  }
  try {
    const identity = await jsonApi("/api/auth/me");
    creditPolicyState = identity.credit_policy || { enabled: false };
    if ("balance" in identity) updateBalance(identity.balance);
    applyArtStyleAccess((_a = identity.user) == null ? void 0 : _a.username);
    await loadData();
    renderCameraOptions();
    onCameraModeChange();
    renderColorPicker();
    renderClothingSelectPanel();
    renderShoeSection();
    getToneSelect();
    updateStoryStyleUI();
    renderLocationConfig();
    switchGame("genshin", document.querySelector(".tab-btn"));
    renderSceneConfig();
    updateSceneTotal();
    const data = await jsonApi("/api/session");
    acceptSession(data);
    applyArtStyleAccess((_b = identity.user) == null ? void 0 : _b.username);
    document.body.hidden = false;
    updateActionButtons();
    if (typeof window !== "undefined") (_c = window.uiLocale) == null ? void 0 : _c.applyTranslations();
    (_d = window.pageBoot) == null ? void 0 : _d.complete();
    void refreshServerStatus();
    await restoreLastImages();
    if (pending) showStatus("An unfinished submission is saved. Submit resumes its original IDs and seeds.", "ok");
  } catch (error) {
    if (loggedOut) return;
    document.body.hidden = false;
    (_e = window.pageBoot) == null ? void 0 : _e.fail(error.message);
    showStatus(error.message, "err");
  }
}
if (typeof window !== "undefined" && window.addEventListener) {
  window.addEventListener("ui-language-change", redrawLanguage);
  window.addEventListener("ui-locale-ready", redrawLanguage);
}
initialize();
