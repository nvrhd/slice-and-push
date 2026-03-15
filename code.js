figma.showUI(__html__, { width: 300, height: 520, themeColors: true });

var COPYABLE = [
  'characters','fontSize','fontName','fills','strokes','strokeWeight','strokeAlign',
  'opacity','visible','cornerRadius','topLeftRadius','topRightRadius','bottomLeftRadius',
  'bottomRightRadius','paddingLeft','paddingRight','paddingTop','paddingBottom',
  'itemSpacing','width','height'
];
var internalSelect = false;
var sliceBuffer = {};

function getPathFromRoot(node, root) {
  var path = [], current = node;
  while (current && current.id !== root.id) {
    var parent = current.parent;
    if (!parent) return null;
    path.unshift(parent.children.indexOf(current));
    current = parent;
  }
  return path;
}
function getNodeByPath(root, path) {
  var current = root;
  for (var i = 0; i < path.length; i++) {
    if (!current.children || current.children.length <= path[i]) return null;
    current = current.children[path[i]];
  }
  return current;
}
function collectInstances(nodes) {
  var result = [];
  for (var i = 0; i < nodes.length; i++) {
    if (nodes[i].type === 'INSTANCE') result.push(nodes[i]);
    else if (nodes[i].children) {
      var n = collectInstances(nodes[i].children);
      for (var j = 0; j < n.length; j++) result.push(n[j]);
    }
  }
  return result;
}
async function pushInstance(instance) {
  var main = await instance.getMainComponentAsync();
  if (!main || main.remote) return false;
  for (var i = 0; i < instance.overrides.length; i++) {
    var ov = instance.overrides[i];
    var instanceNode = instance.id === ov.id ? instance : instance.findOne(function(n) { return n.id === ov.id; });
    if (!instanceNode) continue;
    var path = getPathFromRoot(instanceNode, instance);
    if (!path) continue;
    var mainNode = getNodeByPath(main, path);
    if (!mainNode) continue;
    for (var j = 0; j < ov.overriddenFields.length; j++) {
      var field = ov.overriddenFields[j];
      if (COPYABLE.indexOf(field) === -1) continue;
      try { mainNode[field] = instanceNode[field]; } catch(e) {}
    }
  }
  try { main.resize(instance.width, instance.height); } catch(e) {}
  return true;
}

async function handlePush() {
  var selection = figma.currentPage.selection;
  if (!selection.length) { figma.ui.postMessage({ type: 'error', text: 'Nothing selected' }); return; }
  var instances = collectInstances(selection);
  if (!instances.length) { figma.ui.postMessage({ type: 'error', text: 'No instances in selection' }); return; }
  var pushed = 0, skipped = 0;
  for (var i = 0; i < instances.length; i++) {
    if (await pushInstance(instances[i])) pushed++; else skipped++;
  }
  figma.ui.postMessage({ type: 'done', text: skipped > 0
    ? 'Pushed ' + pushed + ', skipped ' + skipped + ' (remote)'
    : 'Pushed to ' + pushed + ' component' + (pushed !== 1 ? 's' : '') });
}

function handleReset() {
  var selection = figma.currentPage.selection;
  if (!selection.length) { figma.ui.postMessage({ type: 'error', text: 'Nothing selected' }); return; }
  var instances = collectInstances(selection);
  for (var i = 0; i < instances.length; i++) instances[i].removeOverrides();
  figma.ui.postMessage({ type: 'done', text: 'Reset ' + instances.length + ' instance' + (instances.length !== 1 ? 's' : '') });
}

async function buildTree(node, depth) {
  var vars = [];
  if (node.boundVariables) {
    var fields = Object.keys(node.boundVariables);
    for (var f = 0; f < fields.length; f++) {
      var binding = node.boundVariables[fields[f]];
      var bindings = Array.isArray(binding) ? binding : [binding];
      for (var k = 0; k < bindings.length; k++) {
        if (!bindings[k] || !bindings[k].id) continue;
        var v = await figma.variables.getVariableByIdAsync(bindings[k].id);
        if (!v || v.resolvedType !== 'FLOAT') continue;
        var coll = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
        var modeId = coll ? coll.defaultModeId : Object.keys(v.valuesByMode)[0];
        vars.push({ id: v.id, name: v.name, field: fields[f], modeId: modeId, value: v.valuesByMode[modeId] });
      }
    }
  }
  var item = { id: node.id, name: node.name, type: node.type, depth: depth,
    hasVars: vars.length > 0, varNames: vars.map(function(v){ return v.name; }), vars: vars };
  var result = [item];
  if (node.children && depth < 6) {
    for (var i = 0; i < node.children.length; i++) {
      var c = await buildTree(node.children[i], depth + 1);
      for (var j = 0; j < c.length; j++) result.push(c[j]);
    }
  }
  return result;
}
async function collectVarValues(node) {
  var result = {};
  if (node.boundVariables) {
    var fields = Object.keys(node.boundVariables);
    for (var f = 0; f < fields.length; f++) {
      var binding = node.boundVariables[fields[f]];
      var bindings = Array.isArray(binding) ? binding : [binding];
      for (var k = 0; k < bindings.length; k++) {
        if (!bindings[k] || !bindings[k].id) continue;
        var v = await figma.variables.getVariableByIdAsync(bindings[k].id);
        if (!v) continue;
        var coll = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
        var modeId = coll ? coll.defaultModeId : Object.keys(v.valuesByMode)[0];
        result[v.id] = v.valuesByMode[modeId];
      }
    }
  }
  if (node.children) {
    for (var i = 0; i < node.children.length; i++) {
      var ch = await collectVarValues(node.children[i]);
      var keys = Object.keys(ch);
      for (var j = 0; j < keys.length; j++) result[keys[j]] = ch[keys[j]];
    }
  }
  return result;
}
async function handleSaveDimension(msg) {
  var selection = figma.currentPage.selection;
  if (!selection.length) return;
  var node = selection[0];
  var val = parseFloat(msg.value);
  if (isNaN(val)) return;
  if (msg.varId) {
    var variable = await figma.variables.getVariableByIdAsync(msg.varId);
    if (variable) { variable.setValueForMode(msg.modeId, val); figma.ui.postMessage({ type: 'saved', text: variable.name + ' → ' + val }); }
  } else {
    try {
      if (msg.field === 'width')  node.resize(val, node.height);
      if (msg.field === 'height') node.resize(node.width, val);
      figma.ui.postMessage({ type: 'saved', text: msg.field + ' → ' + val });
    } catch(e) {}
  }
  var root = figma.currentPage.selection[0];
  if (root) { figma.ui.postMessage({ type: 'vars-updated', updates: await collectVarValues(root) }); }
}
function handleSelectNode(msg) {
  var node = figma.currentPage.findOne(function(n) { return n.id === msg.nodeId; });
  if (node) { internalSelect = true; figma.currentPage.selection = [node]; }
}

// ── Slice ─────────────────────────────────────────────────────────────────────

async function exportCrop(source, x, y, w, h) {
  var frame = figma.createFrame();
  frame.clipsContent = true;
  frame.fills = [];
  frame.resize(w, h);
  frame.x = -99999;
  frame.y = -99999;
  figma.currentPage.appendChild(frame);
  var clone = source.clone();
  frame.appendChild(clone);
  clone.x = -x;
  clone.y = -y;
  var bytes = await frame.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 } });
  frame.remove();
  return bytes;
}

async function handleSlice(msg) {
  try {
    var selection = figma.currentPage.selection;
    if (!selection.length) { figma.ui.postMessage({ type: 'slice-done', error: 'Select a source frame' }); return; }
    var source = selection[0];
    var W = source.width, H = source.height;
    var L = parseFloat(msg.left)   || 0;
    var R = parseFloat(msg.right)  || 0;
    var T = parseFloat(msg.top)    || 0;
    var B = parseFloat(msg.bottom) || 0;

    var defs;
    if (msg.mode === '3h') {
      defs = [
        { name: 'left',   x: 0,   y: 0, w: L,     h: H },
        { name: 'center', x: L,   y: 0, w: W-L-R, h: H },
        { name: 'right',  x: W-R, y: 0, w: R,     h: H }
      ];
    } else {
      defs = [
        { name: 'topLeft',     x: 0,   y: 0,   w: L,     h: T     },
        { name: 'top',         x: L,   y: 0,   w: W-L-R, h: T     },
        { name: 'topRight',    x: W-R, y: 0,   w: R,     h: T     },
        { name: 'right',       x: W-R, y: T,   w: R,     h: H-T-B },
        { name: 'bottomRight', x: W-R, y: H-B, w: R,     h: B     },
        { name: 'bottom',      x: L,   y: H-B, w: W-L-R, h: B     },
        { name: 'bottomLeft',  x: 0,   y: H-B, w: L,     h: B     },
        { name: 'left',        x: 0,   y: T,   w: L,     h: H-T-B }
      ];
    }

    sliceBuffer = {};
    for (var i = 0; i < defs.length; i++) {
      var d = defs[i];
      if (d.w <= 0 || d.h <= 0) continue;
      figma.ui.postMessage({ type: 'slice-progress', text: 'Slicing ' + d.name + '…  (' + (i+1) + '/' + defs.length + ')' });
      try {
        var bytes = await exportCrop(source, d.x, d.y, d.w, d.h);
        sliceBuffer[d.name] = figma.createImage(bytes).hash;
      } catch(e) {
        console.log('slice skip ' + d.name + ': ' + e.message);
      }
    }
    var names = Object.keys(sliceBuffer);
    figma.ui.postMessage({ type: 'slice-done', count: names.length, names: names });
  } catch(e) {
    figma.ui.postMessage({ type: 'slice-done', error: 'Error: ' + e.message });
  }
}

// ── Push to selected ──────────────────────────────────────────────────────────
// Ищет ЛЮБЫЕ вложенные ноды (авто-лейаут, инстансы, группы) по имени
// и ставит IMAGE fill. Пропускает контейнеры если у них есть дочерние ноды.

async function handlePushToSelected() {
  try {
    var names = Object.keys(sliceBuffer);
    if (!names.length) { figma.ui.postMessage({ type: 'push-result', error: 'No slices in buffer — click Slice first' }); return; }
    var selection = figma.currentPage.selection;
    if (!selection.length) { figma.ui.postMessage({ type: 'push-result', error: 'Select a target frame' }); return; }

    // Какие имена тайлятся — зависит от количества слайсов в буфере
    var tileNames = names.length <= 3
      ? ['center']                          // 3-slice
      : ['left', 'right', 'top', 'bottom']; // 8-slice

    var SHAPES = ['RECTANGLE','ELLIPSE','VECTOR','POLYGON','STAR','LINE','BOOLEAN_OPERATION'];

    function findTargets(node, acc) {
      var nameMatch = names.indexOf(node.name) !== -1;
      if (nameMatch) {
        var isShape = SHAPES.indexOf(node.type) !== -1;
        var isEmptyContainer = !node.children || node.children.length === 0;
        if (isShape || isEmptyContainer) { acc.push(node); return; }
      }
      if (node.children) {
        for (var i = 0; i < node.children.length; i++) findTargets(node.children[i], acc);
      }
    }

    function makeFill(hash, name) {
      if (tileNames.indexOf(name) !== -1) {
        return { type: 'IMAGE', scaleMode: 'TILE', imageHash: hash, scalingFactor: 0.5 };
      }
      return { type: 'IMAGE', scaleMode: 'FILL', imageHash: hash };
    }

    var updated = 0, errMsgs = [];
    for (var s = 0; s < selection.length; s++) {
      var targets = [];
      findTargets(selection[s], targets);
      for (var j = 0; j < targets.length; j++) {
        var hash = sliceBuffer[targets[j].name];
        if (!hash) continue;
        try {
          targets[j].fills = [makeFill(hash, targets[j].name)];
          updated++;
        } catch(e) {
          errMsgs.push(targets[j].name + ': ' + e.message);
        }
      }
    }

    if (updated === 0) {
      figma.ui.postMessage({ type: 'push-result', error: errMsgs.length
        ? errMsgs.join(' | ')
        : 'No matching leaf nodes found. Searched: ' + names.join(', ') });
    } else {
      var txt = 'Applied to ' + updated + ' node' + (updated !== 1 ? 's' : '');
      if (errMsgs.length) txt += '  (' + errMsgs.length + ' skipped)';
      figma.ui.postMessage({ type: 'push-result', text: txt });
    }
  } catch(e) {
    figma.ui.postMessage({ type: 'push-result', error: 'Error: ' + e.message });
  }
}

// ── Selection change ──────────────────────────────────────────────────────────

async function handleSelectionChange() {
  if (internalSelect) { internalSelect = false; return; }
  var selection = figma.currentPage.selection;
  if (!selection.length) {
    figma.ui.postMessage({ type: 'selection', tree: null });
    figma.ui.postMessage({ type: 'slice-info', error: 'Select a frame' });
    return;
  }
  var root = selection[0];
  figma.ui.postMessage({ type: 'selection', tree: await buildTree(root, 0), rootName: root.name });
  var bytes;
  try { bytes = await root.exportAsync({ format: 'PNG', constraint: { type: 'WIDTH', value: 256 } }); }
  catch(e) { figma.ui.postMessage({ type: 'slice-info', error: 'Cannot preview' }); return; }
  figma.ui.postMessage({ type: 'slice-info', imageData: Array.from(bytes),
    frameW: root.width, frameH: root.height, frameName: root.name });
}

figma.on('selectionchange', function() { handleSelectionChange(); });
handleSelectionChange();

figma.ui.onmessage = function(msg) {
  if (msg.type === 'push')             handlePush();
  if (msg.type === 'reset')            handleReset();
  if (msg.type === 'save-dimension')   handleSaveDimension(msg);
  if (msg.type === 'select-node')      handleSelectNode(msg);
  if (msg.type === 'slice')            handleSlice(msg);
  if (msg.type === 'push-to-selected') handlePushToSelected();
};
