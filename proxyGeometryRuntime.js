/* proxyGeometryRuntime.js
   Born-owned proxy geometry projection runtime.

   New model:
   - No set_geom_owner op.
   - No select_geom op.
   - Geometry is born owned: containerCreation carries proxy_id/proxy_type/role.
   - This runtime is a pure deterministic projection/index:
       geometry features + proxy same_as/delete state -> effective visible geometry.

   Expected geometry feature metadata:
     geom_id or feature.getId()
     proxy_id OR proxy_owner.proxy_id
     proxy_type OR proxy_owner.proxy_type
     role OR proxy_owner.role, default "footprint"

   Public API:
     refresh() / refreshAll()
     onProxyStateChanged()
     onGeometryFeatureCreated(feature)
     onGeometryFeatureChanged(featureOrGeomId)
     onGeometryFeatureDeleted(featureOrGeomId)
     geometryStyleWrapper(baseStyleFn)
     installStyle(baseStyleFn)
     getOwnerContext()
*/


console.log("--------------------------- proxyGeometryRuntime.js LOADED born-owned edit-debug v1 ---------------------------");


(function(global) {
  "use strict";

  function installProxyGeometryRuntime(deps) {
    deps = deps || {};

    const ol = deps.ol || global.ol;
    if (!ol) throw new Error("installProxyGeometryRuntime requires OpenLayers");

    const geometrySource = deps.geometrySource;
    const geometryLayer = deps.geometryLayer;
    if (!geometrySource || !geometryLayer) {
      throw new Error("installProxyGeometryRuntime requires geometrySource and geometryLayer");
    }

    const DEFAULT_ROLE = "footprint";
    let geometryEditActive = false;

    const state = {
      proxyComponentByProxyId: new Map(),       // proxy_id -> component_id
      deletedProxyIds: new Set(),              // proxy_id

      candidateByGeomId: new Map(),            // geom_id -> candidate
      candidatesByGroup: new Map(),            // component|role -> Map geom_id -> candidate
      winnerByGroup: new Map(),                // component|role -> geom_id
      groupByGeomId: new Map(),                // geom_id -> groupKey

      featureByGeomId: new Map(),              // geom_id -> feature
      dirtyGeomIds: new Set(),
      dirtyGroups: new Set(),
      flushScheduled: false,

      baseStyleFn: null,
      styleInstalled: false
    };

    function safeString(v) {
      if (v === null || v === undefined) return "";
      return String(v);
    }

    function getOpLog() {
      const log = deps.getOpLog?.();
      return Array.isArray(log) ? log : [];
    }

    function opOrderKey(op) {
      return [
        Number(op?.ts || 0),
        safeString(op?.actor),
        Number(op?.client_seq || 0),
        safeString(op?.op_id)
      ].join("|");
    }

    function compareOps(a, b) {
      const ak = opOrderKey(a);
      const bk = opOrderKey(b);
      if (ak === bk) return 0;
      return ak > bk ? 1 : -1;
    }

    function groupKey(componentId, role) {
      return safeString(componentId) + "|" + safeString(role || DEFAULT_ROLE);
    }

    function getFeatureGeomId(feature) {
      if (!feature) return null;
      return (
        feature.get?.("geom_id") ||
        feature.get?.("geomId") ||
        feature.get?.("state_key") ||
        feature.get?.("stateKey") ||
        feature.get?.("id") ||
        feature.getId?.() ||
        null
      );
    }

    function getOwnerObject(feature) {
      if (!feature) return null;
      const po = feature.get?.("proxy_owner") || feature.get?.("proxyOwner");
      if (po && typeof po === "object") return po;
      return null;
    }

    function getFeatureProxyId(feature) {
      if (!feature) return null;
      const owner = getOwnerObject(feature);
      return (
        feature.get?.("proxy_id") ||
        feature.get?.("proxyId") ||
        feature.get?.("owner_proxy_id") ||
        feature.get?.("ownerProxyId") ||
        owner?.proxy_id ||
        owner?.proxyId ||
        null
      );
    }

    function getFeatureProxyType(feature) {
      if (!feature) return null;
      const owner = getOwnerObject(feature);
      return (
        feature.get?.("proxy_type") ||
        feature.get?.("proxyType") ||
        owner?.proxy_type ||
        owner?.proxyType ||
        null
      );
    }

    function getFeatureRole(feature) {
      if (!feature) return DEFAULT_ROLE;
      const owner = getOwnerObject(feature);
      return (
        feature.get?.("role") ||
        feature.get?.("geometry_role") ||
        feature.get?.("geometryRole") ||
        owner?.role ||
        DEFAULT_ROLE
      );
    }

    function normalizeFeatureOwnerMetadata(feature) {
      if (!feature) return;

      const geomId = getFeatureGeomId(feature);
      if (geomId && !feature.get?.("geom_id")) {
        feature.set?.("geom_id", String(geomId), true);
      }

      const owner = getOwnerObject(feature);
      if (owner) {
        if (!feature.get?.("proxy_id") && (owner.proxy_id || owner.proxyId)) {
          feature.set?.("proxy_id", owner.proxy_id || owner.proxyId, true);
        }
        if (!feature.get?.("proxy_type") && (owner.proxy_type || owner.proxyType)) {
          feature.set?.("proxy_type", owner.proxy_type || owner.proxyType, true);
        }
        if (!feature.get?.("role") && owner.role) {
          feature.set?.("role", owner.role, true);
        }
      }

      if (!feature.get?.("role")) {
        feature.set?.("role", DEFAULT_ROLE, true);
      }
    }

    function extractSameAsPair(op) {
      if (!op || op.op_type !== "same_as") return null;

      const a =
        op.proxy_id ||
        op.proxyId ||
        op.source_proxy_id ||
        op.sourceProxyId ||
        op.a ||
        null;

      const b =
        op.other_proxy_id ||
        op.otherProxyId ||
        op.target_proxy_id ||
        op.targetProxyId ||
        op.same_as_proxy_id ||
        op.sameAsProxyId ||
        op.proxy_id_b ||
        op.proxyIdB ||
        op.b ||
        (typeof op.value === "string" ? op.value : null) ||
        null;

      if (!a || !b || a === b) return null;
      return [String(a), String(b)];
    }

    function getProxyIdFromOp(op) {
      return op?.proxy_id || op?.proxyId || null;
    }

    function rebuildProxyState() {
      const parent = new Map();
      const latestCreate = new Map();
      const latestDelete = new Map();

      function ensure(x) {
        x = safeString(x);
        if (!x) return "";
        if (!parent.has(x)) parent.set(x, x);
        return x;
      }

      function find(x) {
        x = ensure(x);
        if (!x) return "";
        const p = parent.get(x);
        if (p === x) return x;
        const r = find(p);
        parent.set(x, r);
        return r;
      }

      function union(a, b) {
        a = ensure(a);
        b = ensure(b);
        if (!a || !b) return;
        const ra = find(a);
        const rb = find(b);
        if (ra === rb) return;

        // Stable representative independent of op order.
        if (ra < rb) parent.set(rb, ra);
        else parent.set(ra, rb);
      }

      const log = getOpLog();

      // Known proxies from proxy ops.
      for (const op of log) {
        const pid = getProxyIdFromOp(op);
        if (pid) ensure(pid);

        if (op?.op_type === "create_proxy" && pid) {
          const prev = latestCreate.get(pid);
          if (!prev || compareOps(op, prev) > 0) latestCreate.set(pid, op);
        }

        if (op?.op_type === "delete_proxy" && pid) {
          const prev = latestDelete.get(pid);
          if (!prev || compareOps(op, prev) > 0) latestDelete.set(pid, op);
        }
      }

      // Known proxies from geometry owners.
      for (const feature of geometrySource.getFeatures()) {
        const pid = getFeatureProxyId(feature);
        if (pid) ensure(pid);
      }

      // same_as unions.
      for (const op of log) {
        const pair = extractSameAsPair(op);
        if (pair) union(pair[0], pair[1]);
      }

      state.deletedProxyIds.clear();
      for (const pid of parent.keys()) {
        const del = latestDelete.get(pid);
        if (!del) continue;
        const cre = latestCreate.get(pid);
        if (!cre || compareOps(del, cre) > 0) {
          state.deletedProxyIds.add(pid);
        }
      }

      state.proxyComponentByProxyId.clear();
      for (const pid of parent.keys()) {
        state.proxyComponentByProxyId.set(pid, find(pid));
      }
    }

    function getComponentIdForProxy(proxyId) {
      proxyId = safeString(proxyId);
      if (!proxyId) return "";
      return state.proxyComponentByProxyId.get(proxyId) || proxyId;
    }

    function isProxyDeleted(proxyId) {
      return state.deletedProxyIds.has(safeString(proxyId));
    }

    function getGeometryKind(geom) {
      const t = geom?.getType?.() || "";
      if (t.includes("Polygon")) return "polygon";
      if (t.includes("LineString")) return "line";
      if (t.includes("Point")) return "point";
      return "other";
    }

    function countCoords(coords) {
      if (!Array.isArray(coords)) return 0;
      if (typeof coords[0] === "number") return 1;
      let n = 0;
      for (const c of coords) n += countCoords(c);
      return n;
    }

    function ringArea(ring) {
      if (!Array.isArray(ring) || ring.length < 3) return 0;
      let sum = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[j];
        const b = ring[i];
        if (!a || !b) continue;
        sum += (Number(a[0]) || 0) * (Number(b[1]) || 0) -
               (Number(b[0]) || 0) * (Number(a[1]) || 0);
      }
      return Math.abs(sum) / 2;
    }

    function polygonArea(coords) {
      if (!Array.isArray(coords) || !coords.length) return 0;
      let area = ringArea(coords[0]);
      for (let i = 1; i < coords.length; i++) area -= ringArea(coords[i]);
      return Math.max(0, area);
    }

    function lineLength(coords) {
      if (!Array.isArray(coords) || coords.length < 2) return 0;
      let len = 0;
      for (let i = 1; i < coords.length; i++) {
        const a = coords[i - 1];
        const b = coords[i];
        if (!a || !b) continue;
        const dx = (Number(b[0]) || 0) - (Number(a[0]) || 0);
        const dy = (Number(b[1]) || 0) - (Number(a[1]) || 0);
        len += Math.sqrt(dx * dx + dy * dy);
      }
      return len;
    }

    function measureGeometry(feature) {
      const geom = feature?.getGeometry?.();
      if (!geom) return { kind: "none", measure: 0, vertexCount: 0 };

      const kind = getGeometryKind(geom);
      const type = geom.getType?.();
      const coords = geom.getCoordinates?.();
      const vertexCount = countCoords(coords);

      let measure = 0;
      if (type === "Polygon") {
        measure = polygonArea(coords);
      } else if (type === "MultiPolygon") {
        measure = Array.isArray(coords)
          ? coords.reduce((s, p) => s + polygonArea(p), 0)
          : 0;
      } else if (type === "LineString") {
        measure = lineLength(coords);
      } else if (type === "MultiLineString") {
        measure = Array.isArray(coords)
          ? coords.reduce((s, l) => s + lineLength(l), 0)
          : 0;
      }

      return { kind, measure, vertexCount };
    }

    function kindRank(kind) {
      if (kind === "polygon") return 0;
      if (kind === "line") return 1;
      if (kind === "point") return 2;
      return 3;
    }

    // Return negative if a should sort before b / is better.
    function compareCandidates(a, b) {
      const kr = kindRank(a.kind) - kindRank(b.kind);
      if (kr !== 0) return kr;

      if (a.measure !== b.measure) return b.measure - a.measure;       // larger first
      if (a.vertexCount !== b.vertexCount) return b.vertexCount - a.vertexCount;

      // Stable final tie-breaker. Avoid timestamp dependence if possible.
      return safeString(a.geomId).localeCompare(safeString(b.geomId));
    }

    function removeCandidateByGeomId(geomId) {
      geomId = safeString(geomId);
      if (!geomId) return null;

      const oldGroup = state.groupByGeomId.get(geomId);
      if (oldGroup) {
        const group = state.candidatesByGroup.get(oldGroup);
        group?.delete(geomId);
        if (group && group.size === 0) state.candidatesByGroup.delete(oldGroup);
      }

      state.candidateByGeomId.delete(geomId);
      state.groupByGeomId.delete(geomId);
      state.featureByGeomId.delete(geomId);

      return oldGroup || null;
    }

    function makeCandidate(feature) {
      normalizeFeatureOwnerMetadata(feature);

      const geomId = getFeatureGeomId(feature);
      const proxyId = getFeatureProxyId(feature);
      const role = getFeatureRole(feature) || DEFAULT_ROLE;

      if (!geomId || !proxyId) return null;
      if (isProxyDeleted(proxyId)) return null;

      const componentId = getComponentIdForProxy(proxyId);
      if (!componentId) return null;

      const m = measureGeometry(feature);

      return {
        geomId: String(geomId),
        proxyId: String(proxyId),
        proxyType: getFeatureProxyType(feature),
        role: String(role),
        componentId: String(componentId),
        groupKey: groupKey(componentId, role),
        feature,
        kind: m.kind,
        measure: m.measure,
        vertexCount: m.vertexCount
      };
    }

    function recomputeWinnerForGroup(key) {
      if (!key) return;

      const group = state.candidatesByGroup.get(key);
      const oldWinnerId = state.winnerByGroup.get(key) || null;
      let best = null;

      if (group) {
        for (const cand of group.values()) {
          if (!cand) continue;
          if (isProxyDeleted(cand.proxyId)) continue;
          if (!best || compareCandidates(cand, best) < 0) best = cand;
        }
      }

      const newWinnerId = best?.geomId || null;

      if (newWinnerId) state.winnerByGroup.set(key, newWinnerId);
      else state.winnerByGroup.delete(key);

      if (oldWinnerId !== newWinnerId) {
        if (oldWinnerId) state.featureByGeomId.get(oldWinnerId)?.changed?.();
        if (newWinnerId) state.featureByGeomId.get(newWinnerId)?.changed?.();
      } else if (newWinnerId) {
        // Same winner changed geometry/metric.
        state.featureByGeomId.get(newWinnerId)?.changed?.();
      }
    }

    function updateFeature(feature) {
      if (!feature) return null;
      normalizeFeatureOwnerMetadata(feature);

      const geomId = getFeatureGeomId(feature);
      if (!geomId) return null;

      const oldGroup = removeCandidateByGeomId(geomId);
      const cand = makeCandidate(feature);

      if (!cand) {
        if (oldGroup) recomputeWinnerForGroup(oldGroup);
        feature.changed?.();
        return oldGroup;
      }

      state.candidateByGeomId.set(cand.geomId, cand);
      state.groupByGeomId.set(cand.geomId, cand.groupKey);
      state.featureByGeomId.set(cand.geomId, feature);

      if (!state.candidatesByGroup.has(cand.groupKey)) {
        state.candidatesByGroup.set(cand.groupKey, new Map());
      }
      state.candidatesByGroup.get(cand.groupKey).set(cand.geomId, cand);

      if (oldGroup && oldGroup !== cand.groupKey) recomputeWinnerForGroup(oldGroup);
      recomputeWinnerForGroup(cand.groupKey);

      return cand.groupKey;
    }

    function rebuildAll() {
      rebuildProxyState();

      state.candidateByGeomId.clear();
      state.candidatesByGroup.clear();
      state.winnerByGroup.clear();
      state.groupByGeomId.clear();
      state.featureByGeomId.clear();

      const features = geometrySource.getFeatures();
      for (const f of features) {
        const cand = makeCandidate(f);
        if (!cand) continue;

        state.candidateByGeomId.set(cand.geomId, cand);
        state.groupByGeomId.set(cand.geomId, cand.groupKey);
        state.featureByGeomId.set(cand.geomId, f);

        if (!state.candidatesByGroup.has(cand.groupKey)) {
          state.candidatesByGroup.set(cand.groupKey, new Map());
        }
        state.candidatesByGroup.get(cand.groupKey).set(cand.geomId, cand);
      }

      for (const key of state.candidatesByGroup.keys()) {
        recomputeWinnerForGroup(key);
      }

      geometrySource.changed?.();
      geometryLayer.changed?.();
    }

    function featureFromGeomIdOrFeature(featureOrGeomId) {
      if (!featureOrGeomId) return null;
      if (typeof featureOrGeomId === "string") {
        return state.featureByGeomId.get(featureOrGeomId) ||
               geometrySource.getFeatureById?.(featureOrGeomId) ||
               null;
      }
      return featureOrGeomId;
    }

    function markGeometryDirty(featureOrGeomId) {
      if (geometryEditActive) return;

      const feature = featureFromGeomIdOrFeature(featureOrGeomId);
      const geomId = feature ? getFeatureGeomId(feature) : safeString(featureOrGeomId);
      if (!geomId) return;

      state.dirtyGeomIds.add(String(geomId));

      if (state.flushScheduled) return;
      state.flushScheduled = true;

      requestAnimationFrame(() => {
        state.flushScheduled = false;
        const ids = Array.from(state.dirtyGeomIds);
        state.dirtyGeomIds.clear();

        const affectedGroups = new Set();

        for (const id of ids) {
          const f = state.featureByGeomId.get(id) ||
                    geometrySource.getFeatureById?.(id) ||
                    null;
          if (!f) {
            const oldGroup = removeCandidateByGeomId(id);
            if (oldGroup) affectedGroups.add(oldGroup);
            continue;
          }

          const beforeGroup = state.groupByGeomId.get(id);
          const afterGroup = updateFeature(f);
          if (beforeGroup) affectedGroups.add(beforeGroup);
          if (afterGroup) affectedGroups.add(afterGroup);
        }

        for (const key of affectedGroups) recomputeWinnerForGroup(key);
        geometryLayer.changed?.();
      });
    }

    function isFeatureWinner(feature) {
      const geomId = getFeatureGeomId(feature);
      if (!geomId) return false;
      const key = state.groupByGeomId.get(String(geomId));
      if (!key) return false;
      return state.winnerByGroup.get(key) === String(geomId);
    }

    function defaultBaseStyle(feature) {
      const geom = feature?.getGeometry?.();
      const type = geom?.getType?.() || "";

      const stroke = new ol.style.Stroke({
        color: "#ff9800",
        width: 3
      });

      const fill = new ol.style.Fill({
        color: "rgba(255,152,0,0.08)"
      });

      const image = new ol.style.Circle({
        radius: 5,
        fill: new ol.style.Fill({ color: "#ff9800" }),
        stroke: new ol.style.Stroke({ color: "#fff", width: 1 })
      });

      return new ol.style.Style({
        stroke,
        fill: type.includes("Polygon") ? fill : undefined,
        image
      });
    }

    function normalizeStyleFunction(baseStyleFn) {
      if (typeof baseStyleFn === "function") return baseStyleFn;
      if (baseStyleFn) return () => baseStyleFn;
      return defaultBaseStyle;
    }


    function geometryStyleWrapper(baseStyleFn) {
      const base = normalizeStyleFunction(baseStyleFn || state.baseStyleFn);
      return function(feature, resolution) {
        // Even in edit mode, only the deterministic winner should be visible/editable.
        // Edit mode only disables live reindexing during drag; it should not expose
        // losing geometries.
        if (!isFeatureWinner(feature)) return null;
        return base(feature, resolution);
      };
    }



    function installStyle(baseStyleFn) {
      state.baseStyleFn = normalizeStyleFunction(baseStyleFn || geometryLayer.getStyle?.());
      geometryLayer.setStyle(geometryStyleWrapper(state.baseStyleFn));
      state.styleInstalled = true;
      geometryLayer.changed?.();
    }

    function getOwnerContext(roleOverride) {
      const proxyId = deps.getSelectedProxyId?.() ||
        deps.proxyRuntime?.getSelectedProxyId?.() ||
        null;

      if (!proxyId) return null;

      return {
        proxy_id: proxyId,
        proxy_type: deps.getActiveProxyType?.() || null,
        role: roleOverride || deps.getConfig?.()?.geometryAssociation?.default_role || DEFAULT_ROLE
      };
    }

    // Automatically track geometrySource changes. These are incremental and cheap.
    if (geometrySource.on) {
      geometrySource.on("addfeature", evt => {
        const f = evt?.feature;
        if (!f) return;
        // Metadata may be set by geometry runtime immediately after add; use one tick.
        setTimeout(() => markGeometryDirty(f), 0);
      });

      geometrySource.on("removefeature", evt => {
        const f = evt?.feature;
        const geomId = getFeatureGeomId(f);
        if (!geomId) return;
        const oldGroup = removeCandidateByGeomId(geomId);
        if (oldGroup) recomputeWinnerForGroup(oldGroup);
        geometryLayer.changed?.();
      });

      geometrySource.on("changefeature", evt => {
        if (geometryEditActive) return;

        const f = evt?.feature;
        if (f) markGeometryDirty(f);
      });
    }

    // Install default winner-only style immediately. Editor can override by calling installStyle().
    installStyle(geometryLayer.getStyle?.());
    rebuildAll();

    return {
      refresh: rebuildAll,
      refreshAll: rebuildAll,
      setGeometryEditActive(active) {
        const next = !!active;
        if (geometryEditActive === next) return;

        geometryEditActive = next;

        // While edit mode is active, style wrapper shows all geometry and
        // incremental changefeature reindexing is disabled. When edit mode ends,
        // rebuild once from the final geometry state.
        if (!geometryEditActive) {
          rebuildAll();
        }

        for (const f of geometrySource.getFeatures()) {
          f.changed?.();
        }
        geometrySource.changed?.();
        geometryLayer.changed?.();
      },

      isGeometryEditActive() {
        return geometryEditActive;
      },

      onProxyStateChanged: rebuildAll,
      onGeometryFeatureCreated: updateFeature,
      onGeometryFeatureChanged: markGeometryDirty,
      onGeometryFeatureDeleted: featureOrGeomId => {
        const feature = featureFromGeomIdOrFeature(featureOrGeomId);
        const geomId = feature ? getFeatureGeomId(feature) : safeString(featureOrGeomId);
        const oldGroup = removeCandidateByGeomId(geomId);
        if (oldGroup) recomputeWinnerForGroup(oldGroup);
        geometryLayer.changed?.();
      },
      markGeometryDirty,
      geometryStyleWrapper,
      installStyle,
      getOwnerContext,
      isFeatureWinner,
      getState: () => state
    };
  }

  global.installProxyGeometryRuntime = installProxyGeometryRuntime;
})(window);
