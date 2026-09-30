import { LitElement, html, css, svg, nothing } from "lit";
import { DEFAULTS, DEFAULT_PRICE_STOPS, PRICE_PROFILES } from "./constants.js";
import { t, resolveLang } from "./maurits-translations.js";
import { VISUAL_HOUSE_IMAGE } from "./assets/visual-house.js";
import "./maurits-energy-flow-card-editor.js";

let _mefUidCounter = 0;

// Bring a provider price value into a sane EUR/kWh range.
// Some integrations report scaled integers (e.g. Zonneplan uses value x1e7,
// where 0.30 EUR/kWh arrives as 3000000). We divide by the power-of-ten scale
// that lands the value closest to a typical tariff (~0.05..1.00 EUR/kWh).
function normalizePrice(v) {
  if (v == null || isNaN(v)) return v;
  const a = Math.abs(v);
  if (a === 0) return 0;
  // Already a plausible EUR/kWh value.
  if (a >= 0.005 && a <= 5) return v;
  // Try each power of ten; choose the scaling that lands in the typical band.
  const scales = [1, 10, 100, 1000, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9];
  let best = v, bestScore = Infinity;
  for (const s of scales) {
    const scaled = a / s;
    if (scaled < 0.02 || scaled > 2) continue;          // outside typical tariff band
    const score = Math.abs(Math.log(scaled / 0.25));     // closeness to ~0.25 EUR/kWh
    if (score < bestScore) { bestScore = score; best = v / s; }
  }
  return best;
}

// Determine one scale factor for a whole price series from providers that report scaled
// integers (e.g. Zonneplan's price_tax_included.amount, x1e7). Uses the median of the
// series rather than scaling each point independently — a single price spike can't skew
// the median enough to flip the detected scale, unlike normalizePrice() applied per point.
function detectPriceScale(rawValues) {
  const abs = rawValues.map((v) => Math.abs(v)).filter((v) => v > 0);
  if (!abs.length) return 1;
  const sorted = [...abs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (median >= 0.005 && median <= 5) return 1; // already plausible EUR/kWh
  const scales = [1, 10, 100, 1000, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9];
  let best = 1, bestScore = Infinity;
  for (const s of scales) {
    const scaled = median / s;
    if (scaled < 0.02 || scaled > 2) continue;
    const score = Math.abs(Math.log(scaled / 0.25));
    if (score < bestScore) { bestScore = score; best = s; }
  }
  return best;
}

function num(hass, entity) {
  if (!entity || !hass || !hass.states[entity]) return null;
  const v = parseFloat(hass.states[entity].state);
  return isNaN(v) ? null : v;
}

function fmtEnergy(kwh) {
  if (kwh === null) return "–";
  return `${kwh.toFixed(1).replace(".", ",")} kWh`;
}

function fmtPrice(price) {
  if (price === null) return "–";
  return `€ ${normalizePrice(price).toFixed(3).replace(".", ",")}/kWh`;
}

function fmtVoltage(voltage) {
  return voltage === null ? "" : `${Math.round(voltage)} V`;
}

function fmtPower(w) {
  if (w === null) return "–";
  const a = Math.abs(w);
  if (a >= 1000) return (w / 1000).toFixed(2).replace(".", ",") + " kW";
  return Math.round(w) + " W";
}

function hex2rgb(h) {
  const m = h.replace("#", "");
  const n = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
}
function rgb2hex(r, g, b) {
  const c = (x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0");
  return "#" + c(r) + c(g) + c(b);
}
function colorForValue(value, stops) {
  if (!stops || !stops.length) return "#888";
  const s = [...stops].sort((a, b) => a.value - b.value);
  if (value <= s[0].value) return s[0].color;
  if (value >= s[s.length - 1].value) return s[s.length - 1].color;
  for (let i = 0; i < s.length - 1; i++) {
    const a = s[i], b = s[i + 1];
    if (value >= a.value && value <= b.value) {
      const t = (value - a.value) / (b.value - a.value || 1);
      const ca = hex2rgb(a.color), cb = hex2rgb(b.color);
      return rgb2hex(ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t);
    }
  }
  return s[s.length - 1].color;
}

// Catmull-Rom-style smoothing converted to cubic beziers, for the "line" layout profiles.
function catmullRomToBezierPath(pts) {
  if (!pts.length) return "";
  if (pts.length === 1) return `M${pts[0].x.toFixed(2)},${pts[0].y.toFixed(2)}`;
  if (pts.length === 2) {
    return `M${pts[0].x.toFixed(2)},${pts[0].y.toFixed(2)} L${pts[1].x.toFixed(2)},${pts[1].y.toFixed(2)}`;
  }
  let d = `M${pts[0].x.toFixed(2)},${pts[0].y.toFixed(2)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`;
  }
  return d;
}

// Walk a polyline (array of {x,y}) by real arc-length, for placing a fade exactly at
// the tips of a bent wire instead of approximating it over the straight-line distance
// (which drifts into the bend as soon as the path isn't straight).
function polyLen(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return L;
}
function polyPointAt(pts, d) {
  let remain = Math.max(0, d);
  for (let i = 1; i < pts.length; i++) {
    const segLen = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (remain <= segLen || i === pts.length - 1) {
      const t = segLen ? Math.min(1, remain / segLen) : 0;
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t, seg: i };
    }
    remain -= segLen;
  }
  return { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y, seg: pts.length - 1 };
}
function subPathD(pts, dStart, dEnd) {
  const a = polyPointAt(pts, dStart);
  const b = polyPointAt(pts, dEnd);
  const mid = pts.slice(a.seg, b.seg);
  const all = [a, ...mid, b];
  return all.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
}

class MauritsEnergyFlowCard extends LitElement {
  static get properties() {
    return { hass: {}, _config: {} };
  }

  constructor() {
    super();
    this._uid = ++_mefUidCounter;
  }

  static getConfigElement() {
    return document.createElement("maurits-energy-flow-card-editor");
  }

  static getStubConfig() {
    return {
      show_flow: true,
      show_price: true,
      solar_power: "",
      grid_power: "",
      grid_voltage_entity: "",
      battery_charge_power: "",
      battery_discharge_power: "",
      battery_soc: "",
      grid_import_today_entity: "",
      solar_energy_today_entity: "",
      current_price_entity: "",
      price_entity: "",
    };
  }

  setConfig(config) {
    if (!config) throw new Error("Invalid configuration");
    this._config = { ...DEFAULTS, wire_style: "modern", ...config };
    if (!Array.isArray(this._config.price_stops) || !this._config.price_stops.length) {
      this._config.price_stops = DEFAULT_PRICE_STOPS;
    }
    if (!PRICE_PROFILES[this._config.price_profile]) {
      this._config.price_profile = "default";
    }
    this._startChartScroll();
  }

  getCardSize() {
    return (this._config.show_flow ? 6 : 0) + (this._config.show_price ? 6 : 0) || 1;
  }

  // Ask Home Assistant's Sections dashboard to give this card a full-width, tall
  // tile. Masonry dashboards still size from the rendered content/getCardSize().
  getGridOptions() {
    return {
      columns: 12,
      min_columns: 6,
      rows: this._config?.show_flow && this._config?.show_price ? 12 : 6,
      min_rows: 6,
    };
  }

  _homePower(v) {
    if (v.solar === null && v.grid === null && v.charge === null && v.discharge === null) return null;
    let h = 0;
    if (v.solar !== null) h += v.solar;
    if (v.grid !== null) h += v.grid;
    if (v.discharge !== null) h += v.discharge;
    if (v.charge !== null) h -= v.charge;
    return h;
  }

  _t(key) {
    return t(resolveLang(this._config?.language, this.hass), key);
  }

  _activeProfile() {
    return PRICE_PROFILES[this._config?.price_profile] || PRICE_PROFILES.default;
  }

  // Per-wire animation state: tracks last time a wire had meaningful power,
  // so lines can fade in when active and fade out after flow_off_delay seconds.
  // `reversed` is the wire's raw current direction (e.g. grid export vs import); when
  // it flips, the displayed direction only follows after a brief fade-out/in so a wire
  // that oscillates rapidly (a jittery sensor near 0 W) settles instead of snapping the
  // line's shape back and forth instantly.
  // Returns { show, moving, duration (s), fade ('in'|'out'|null), reversed, dirSwap }.
  _wireState(key, power, reversed = false) {
    this._wires = this._wires || {};
    const now = Date.now();
    const c = this._config;
    const p = power === null ? 0 : Math.abs(power);
    const active = p > 5;
    let w = this._wires[key];
    if (!w) w = this._wires[key] = { lastActive: active ? now : 0, shownSince: active ? now : 0, wasShown: active, dispReversed: reversed, dirPhase: "idle", dirPhaseStart: 0 };

    if (active) {
      w.lastActive = now;
      if (!w.wasShown) { w.wasShown = true; w.shownSince = now; }
    }
    const offDelay = Math.max(0, (c.flow_off_delay ?? 20)) * 1000;
    const sinceActive = now - w.lastActive;
    const show = active || (w.wasShown && sinceActive < offDelay);
    if (!show) w.wasShown = false;

    // Direction-change crossfade: dip to 0 opacity, swap the path shape while
    // invisible, then fade back in — instead of an abrupt instant redraw.
    const DIR_FADE_MS = 320;
    if (w.dirPhase === "idle" && reversed !== w.dispReversed) {
      w.dirPhase = "out";
      w.dirPhaseStart = now;
      setTimeout(() => this.requestUpdate(), DIR_FADE_MS + 10);
    } else if (w.dirPhase === "out" && now - w.dirPhaseStart >= DIR_FADE_MS) {
      w.dispReversed = reversed;
      w.dirPhase = "in";
      w.dirPhaseStart = now;
      setTimeout(() => this.requestUpdate(), DIR_FADE_MS + 10);
    } else if (w.dirPhase === "in" && now - w.dirPhaseStart >= DIR_FADE_MS) {
      w.dirPhase = "idle";
    }
    const dirSwap = w.dirPhase !== "idle";

    // speed: linear from 0..flow_max_power, scaled by flow_speed multiplier.
    const maxP = Math.max(100, c.flow_max_power ?? 5000);
    const frac = Math.max(0, Math.min(1, p / maxP));
    const speedMul = Math.max(0.1, c.flow_speed ?? 1.0);
    // duration: fast (small number) at high power, slow (large) near zero.
    // frac 1 -> ~0.5s, frac ~0 -> ~6s. Divided by the user multiplier.
    const duration = active ? (6 - 5.5 * frac) / speedMul : 0;

    // fade direction
    let fade = null;
    if (active && now - w.shownSince < 800) fade = "in";
    else if (!active && show) fade = "out";
    if (w.dirPhase === "out") fade = "out";
    else if (w.dirPhase === "in") fade = "in";

    return { show, moving: active, duration, fade, reversed: w.dispReversed, dirSwap };
  }

  // Ensure the card keeps repainting while any wire is counting down to fade-out,
  // even if Home Assistant sends no new state updates.
  _scheduleFlowTick() {
    if (this._flowTimer) return;
    this._flowTimer = setInterval(() => {
      const wires = this._wires || {};
      const now = Date.now();
      const offDelay = Math.max(0, (this._config?.flow_off_delay ?? 20)) * 1000;
      const pending = Object.values(wires).some((w) => w.wasShown && now - w.lastActive < offDelay + 1000);
      this.requestUpdate();
      if (!pending) { clearInterval(this._flowTimer); this._flowTimer = null; }
    }, 1000);
  }

  // Fetch prices via the tibber.get_prices service call (return_response) instead of an
  // entity attribute — for Tibber setups whose sensor only exposes daily stats, not a
  // price array. Picks the first home returned; multi-home Tibber accounts aren't
  // distinguished (matches the only known-working example config for this).
  async _ensureTibberPrices() {
    if (!this.hass?.connection) return;
    const cached = this._tibberPrices;
    if (cached && Date.now() - cached.fetched < 900000) return; // refresh every 15 min
    try {
      const end = new Date(Date.now() + 2 * 86400000).toISOString();
      const res = await this.hass.connection.sendMessagePromise({
        type: "call_service",
        domain: "tibber",
        service: "get_prices",
        return_response: true,
        service_data: { end },
      });
      const homes = res?.response?.prices || {};
      const data = Object.values(homes)[0] || [];
      this._tibberPrices = { fetched: Date.now(), data };
      this.requestUpdate();
    } catch (e) {
      this._tibberPrices = { fetched: Date.now(), data: [], error: true };
      this.requestUpdate();
    }
  }

  _tibberPriceData() {
    const data = this._tibberPrices?.data || [];
    const seen = new Set();
    const merged = [];
    for (const p of data) {
      const from = p.start_time ?? p.from;
      const price = p.price ?? p.total;
      const t = from ? new Date(from).getTime() : null;
      let val = typeof price === "number" ? price : parseFloat(price);
      if (t && !isNaN(val)) {
        val = normalizePrice(val);
        if (!seen.has(t)) { seen.add(t); merged.push({ t, v: val }); }
      }
    }
    merged.sort((a, b) => a.t - b.t);
    const now = Date.now();
    let current = null;
    for (const p of merged) { if (p.t <= now) current = p.v; else break; }
    return { points: merged, current };
  }

  _priceData() {
    const cfg = this._config;
    if (cfg.price_use_tibber_service) return this._tibberPriceData();
    const ent = this.hass?.states?.[cfg.price_entity];
    if (!ent) return { points: [], current: null };
    const attrs = ent.attributes || {};
    const candidates = [
      attrs.prices, attrs.prices_today, attrs.today, attrs.raw_today,
      attrs.data, attrs.forecast, attrs.raw_tomorrow, attrs.prices_tomorrow, attrs.tomorrow,
    ].filter(Boolean);
    let merged = [];
    const seen = new Set();
    for (const arr of candidates) {
      if (!Array.isArray(arr)) continue;
      for (const p of arr) {
        const from = p.from ?? p.start ?? p.start_time ?? p.start_date ?? p.time ?? p.datetime ?? p.date;
        // Zonneplan nests price under objects; also uses electricity_price (x1e7).
        // EPEX Spot Data integration uses price_per_kwh (start_time/end_time), 15-min slots.
        let price = p.price ?? p.value ?? p.total ?? p.price_per_kwh ?? p.marketPrice ?? p.market_price ??
          p.electricity ?? p.electricity_price ??
          p.price_tax_included?.amount ?? p.price_tax_excluded?.amount;
        const t = from ? new Date(from).getTime() : null;
        const val = typeof price === "number" ? price : parseFloat(price);
        if (t && !isNaN(val) && !seen.has(t)) { seen.add(t); merged.push({ t, raw: val }); }
      }
    }
    merged.sort((a, b) => a.t - b.t);
    // Auto-scale providers that report scaled integers (e.g. Zonneplan x1e7): detect ONE
    // scale for the whole series (from the median), not per point. Guessing per point let
    // an individual price spike (e.g. one quarter above ~0.79 EUR/kWh at a x1e7 scale)
    // occasionally get misjudged as a completely different magnitude than its neighbours,
    // rendering a false, isolated crash to near-zero exactly where the real price peaked.
    const scale = detectPriceScale(merged.map((p) => p.raw));
    const points = merged.map((p) => ({ t: p.t, v: p.raw / scale }));
    let current = num(this.hass, cfg.price_entity);
    if (current !== null) current = normalizePrice(current);
    return { points, current };
  }

  render() {
    if (!this._config || !this.hass) return nothing;
    return html`
      <ha-card>
        <div class="stack">
          ${this._config.show_flow ? this._renderFlow() : nothing}
          ${this._config.show_price ? this._renderPrice() : nothing}
        </div>
      </ha-card>
    `;
  }

  _renderFlow() {
    const c = this._config;
    const v = {
      solar: num(this.hass, c.solar_power),
      grid: num(this.hass, c.grid_power),
      gridVoltage: num(this.hass, c.grid_voltage_entity),
      charge: num(this.hass, c.battery_charge_power),
      discharge: num(this.hass, c.battery_discharge_power),
      soc: num(this.hass, c.battery_soc),
    };
    const home = this._homePower(v);
    const info = {
      gridImportToday: num(this.hass, c.grid_import_today_entity),
      solarEnergyToday: num(this.hass, c.solar_energy_today_entity),
      currentPrice: num(this.hass, c.current_price_entity),
    };

    const battValue = (v.charge && v.charge > 5) ? v.charge : (v.discharge && v.discharge > 5) ? v.discharge : (v.charge ?? v.discharge);
    const battLabel = v.charge && v.charge > 5 ? this._t("charging") : v.discharge && v.discharge > 5 ? this._t("discharging") : "";

    const gridLabel = v.grid === null ? "" : v.grid < 0 ? this._t("export") : this._t("import");

    // The three flow nodes are always shown. A node is muted when its entity is
    // not configured, while configured nodes retain the original color treatment.
    const solarHasEnt = !!c.solar_power;
    const gridHasEnt = !!c.grid_power;
    const battHasEnt = !!(c.battery_charge_power || c.battery_discharge_power);

    const GREY = "#6b7280";
    const solarCol = solarHasEnt ? c.color_solar : GREY;
    const gridCol = gridHasEnt ? c.color_grid : GREY;
    const battCol = battHasEnt ? c.color_battery : GREY;
    const bs = (() => {
      const r = 23, circ = 2 * Math.PI * r;
      const pct = v.soc === null ? 0 : Math.max(0, Math.min(100, v.soc)) / 100;
      return { circ, offset: circ * (1 - pct) };
    })();

    // House square center in the 720x190 viewBox. Lowered a bit.
    // Icon ~58px; horizontal half-width in viewBox units ≈ 34.
    const HX = 360, HY = 104;          // vertical center of the house square (lowered)
    const HL = HX - 34, HR = HX + 34;  // left / right edge of the square

    // Visual layout: an actual house photo replaces the abstract square. It's drawn as a
    // centered 190x190 sub-region of this same 720x190 viewBox (matching HX), so each wire
    // can aim at a specific spot on the picture (solar panels / battery box) instead
    // of the shared square edge used by the abstract layout.
    const visual = !!c.use_visual_layout;
    const VX = HX - 95, VY = 0, VS = 190;
    const visPt = (px, py) => ({ x: VX + (px / 100) * VS, y: VY + (py / 100) * VS });
    const EP = {
      solar: visual ? visPt(46, 31) : { x: HL, y: HY },
      grid: visual ? visPt(80, 40) : { x: HR, y: HY },
      battery: visual ? visPt(58, 63) : { x: HL, y: HY },
    };
    // Wire icon-side start points. In visual mode these sit above/below the whole
    // icon+text block and further out horizontally, so lines don't cross the photo's
    // wattage text. The abstract layout's smooth curve doesn't have that problem, so it
    // keeps its original, closer-to-the-icon start points.
    const TOP_Y = visual ? 4 : 52;
    const IX_L = visual ? 110 : 70, IX_R = visual ? 610 : 650;
    const BOT_Y_BATT = visual ? 186 : 138;
    // The battery is the only lower flow branch.
    const FX_L = visual ? (EP.solar.x + EP.battery.x) / 2 : HL;
    const FX_R = visual ? EP.grid.x : HR;
    const huisLeftPct = 50;

    // Per-wire animation states
    const solarPow = v.solar;
    const gridPow = v.grid;
    const battPow = v.charge && v.charge > 5 ? v.charge : (v.discharge && v.discharge > 5 ? v.discharge : 0);
    const wSolar = this._wireState("solar", solarPow, false);
    const wGrid = this._wireState("grid", gridPow, gridPow < 0);
    const wBatt = this._wireState("batt", battPow, v.charge && v.charge > 5);
    if (wSolar.show || wGrid.show || wBatt.show) this._scheduleFlowTick();

    const wireStyles = ["modern", "dashed", "neon", "solid", "soft-glow", "gradient", "pulse"];
    const wireStyle = wireStyles.includes(c.wire_style) ? c.wire_style : "dashed";
    // Animated styles retain the existing Web Animations playback-rate tuning below, so
    // their speed continues to follow flow_speed without restarting on sensor updates.
    const reduceEffects = !!c.reduce_effects;
    const liveGradId = (name) => `mef-live-${name}-${this._uid}`;
    const liveStyle = (st, color, name) => {
      const stroke = wireStyle === "gradient" ? `url(#${liveGradId(name)})` : color;
      const glow = wireStyle === "neon" && !reduceEffects
        ? `filter:drop-shadow(0 0 2px ${color}) drop-shadow(0 0 6px ${color});`
        : wireStyle === "soft-glow" && !reduceEffects
          ? `filter:drop-shadow(0 0 2px ${color});`
          : "";
      return `stroke:${stroke};${glow}${st.moving ? "" : "animation-play-state:paused;"}`;
    };
    const liveClass = (st) => `live ${wireStyle}${st.fade === "in" ? " fade-in" : ""}${st.fade === "out" ? " fade-out" : ""}${st.moving ? "" : " still"}${st.dirSwap ? " dir-swap" : ""}`;
    const pulseBaseStyle = (color) => `stroke:${color};opacity:.42;`;

    // Visual-mode wires run in clean horizontal/vertical segments via a shared bend
    // line (frameX) — a photo reads better with straight "circuit style" connectors,
    // and sharing the bend keeps the top/bottom line on each side true mirror images.
    // The abstract layout keeps its smooth curve. `reversed` traces the SAME physical
    // line backwards (same corners) so the dim base wire and the live overlay always
    // stay perfectly aligned — only the flow animation's apparent direction changes.
    const elbowD = (iconX, iconY, ep, frameX, reversed) => {
      const pts = [{ x: iconX, y: iconY }, { x: frameX, y: iconY }, { x: frameX, y: ep.y }, { x: ep.x, y: ep.y }];
      const p = reversed ? [...pts].reverse() : pts;
      return `M${p[0].x},${p[0].y} L${p[1].x},${p[1].y} L${p[2].x},${p[2].y} L${p[3].x},${p[3].y}`;
    };
    const wireD = (iconX, iconY, ep, frameX, curveCtrlX, reversed) => visual
      ? elbowD(iconX, iconY, ep, frameX, reversed)
      : (reversed ? `M${ep.x},${ep.y} Q${curveCtrlX},${HY} ${iconX},${iconY}` : `M${iconX},${iconY} Q${curveCtrlX},${HY} ${ep.x},${ep.y}`);

    // The base wire fades in from the icon end and out again near the house. In visual
    // mode this is computed along the wire's real (bent) arc length so the fade sits at
    // the actual tips instead of drifting into the bend on longer runs; the abstract
    // layout's smooth curve has no sharp corner, so a simple straight-line gradient is
    // used there instead.
    const gradId = (name) => `efp-fade-${name}-${this._uid}`;
    const FADE_LEN = 40;
    const baseWire = (name, iconX, iconY, ep, frameX, curveCtrlX) => {
      if (!visual) {
        const id = gradId(name);
        return {
          defs: svg`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${iconX}" y1="${iconY}" x2="${ep.x}" y2="${ep.y}">
            <stop offset="0" stop-color="#fff" stop-opacity="0"></stop>
            <stop offset="0.12" stop-color="#fff" stop-opacity="0.07"></stop>
            <stop offset="0.94" stop-color="#fff" stop-opacity="0.07"></stop>
            <stop offset="1" stop-color="#fff" stop-opacity="0"></stop>
          </linearGradient>`,
          path: svg`<path class="wire" style="stroke:url(#${id})" d="M${iconX},${iconY} Q${curveCtrlX},${HY} ${ep.x},${ep.y}"></path>`,
        };
      }
      const pts = [{ x: iconX, y: iconY }, { x: frameX, y: iconY }, { x: frameX, y: ep.y }, { x: ep.x, y: ep.y }];
      const total = polyLen(pts);
      const fl = Math.min(FADE_LEN, total / 2);
      const aEnd = polyPointAt(pts, fl);
      const bStart = polyPointAt(pts, total - fl);
      const idIn = gradId(name + "-in"), idOut = gradId(name + "-out");
      return {
        defs: svg`
          <linearGradient id="${idIn}" gradientUnits="userSpaceOnUse" x1="${pts[0].x}" y1="${pts[0].y}" x2="${aEnd.x}" y2="${aEnd.y}">
            <stop offset="0" stop-color="#fff" stop-opacity="0"></stop>
            <stop offset="1" stop-color="#fff" stop-opacity="0.07"></stop>
          </linearGradient>
          <linearGradient id="${idOut}" gradientUnits="userSpaceOnUse" x1="${bStart.x}" y1="${bStart.y}" x2="${pts[3].x}" y2="${pts[3].y}">
            <stop offset="0" stop-color="#fff" stop-opacity="0.07"></stop>
            <stop offset="1" stop-color="#fff" stop-opacity="0"></stop>
          </linearGradient>`,
        path: svg`
          <path class="wire" style="stroke:url(#${idIn})" d="${subPathD(pts, 0, fl)}"></path>
          ${total - 2 * fl > 0.5 ? svg`<path class="wire" d="${subPathD(pts, fl, total - fl)}"></path>` : nothing}
          <path class="wire" style="stroke:url(#${idOut})" d="${subPathD(pts, total - fl, total)}"></path>`,
      };
    };
    const wSolarBase = baseWire("solar", IX_L, TOP_Y, EP.solar, FX_L, 220);
    const wGridBase = baseWire("grid", IX_R, TOP_Y, EP.grid, FX_R, 500);
    const wBattBase = baseWire("battery", IX_L, BOT_Y_BATT, EP.battery, FX_L, 220);
    const liveGradient = (name, color, x1, y1, x2, y2) => svg`
      <linearGradient id="${liveGradId(name)}" gradientUnits="userSpaceOnUse" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">
        <stop offset="0" stop-color="${color}" stop-opacity="0.55"></stop>
        <stop offset="0.5" stop-color="${color}" stop-opacity="1"></stop>
        <stop offset="1" stop-color="${color}" stop-opacity="0.72"></stop>
      </linearGradient>`;
    const renderLiveWire = (name, state, color, d) => !state.show ? nothing : svg`
      ${wireStyle === "pulse" || wireStyle === "modern" ? svg`<path class="live pulse-base" style="${pulseBaseStyle(color)}" d="${d}"></path>` : nothing}
      <path class="${liveClass(state)}" style="${liveStyle(state, color, name)}" data-speed="${state.duration}" d="${d}"></path>`;

    return html`
      <div class="flow">
        ${visual ? html`<img class="housepic" src="${VISUAL_HOUSE_IMAGE}" alt="" />` : nothing}
        <svg class="wires" viewBox="0 0 720 190" preserveAspectRatio="none">
          <defs>
            ${wSolarBase.defs}${wGridBase.defs}${wBattBase.defs}
            ${liveGradient("solar", c.color_solar, IX_L, TOP_Y, EP.solar.x, EP.solar.y)}
            ${liveGradient("grid", c.color_grid, IX_R, TOP_Y, EP.grid.x, EP.grid.y)}
            ${liveGradient("battery", c.color_battery, IX_L, BOT_Y_BATT, EP.battery.x, EP.battery.y)}
          </defs>
          ${wSolarBase.path}
          ${renderLiveWire("solar", wSolar, c.color_solar, wireD(IX_L, TOP_Y, EP.solar, FX_L, 220, false))}

          ${wGridBase.path}
          ${renderLiveWire("grid", wGrid, c.color_grid, wireD(IX_R, TOP_Y, EP.grid, FX_R, 500, wGrid.reversed))}

          ${wBattBase.path}
          ${renderLiveWire("battery", wBatt, c.color_battery, wireD(IX_L, BOT_Y_BATT, EP.battery, FX_L, 220, wBatt.reversed))}

        </svg>

        <div class="node tl ${solarHasEnt ? "" : "muted"}">
          <div class="ic" style="color:${solarCol};border-color:${solarCol}66;background:${solarCol}22">
            <ha-icon icon="mdi:solar-power-variant"></ha-icon>
          </div>
          <div class="txt"><span class="lbl">${this._t("solar")}</span><span class="val" style="color:${solarCol}">${fmtPower(v.solar)}</span></div>
        </div>

        <div class="node tr ${gridHasEnt ? "" : "muted"}">
          <div class="ic" style="color:${gridCol};border-color:${gridCol}66;background:${gridCol}22">
            <ha-icon icon="mdi:transmission-tower"></ha-icon>
          </div>
          <div class="txt"><span class="lbl">${this._t("grid")}</span><span class="val" style="color:${gridCol}">${fmtPower(v.grid)}</span>${gridLabel ? html`<span class="sub" style="color:${gridCol}">${gridLabel}</span>` : nothing}${v.gridVoltage !== null ? html`<span class="sub grid-voltage" style="color:${gridCol}">${fmtVoltage(v.gridVoltage)}</span>` : nothing}</div>
        </div>

        <div class="node bl ${battHasEnt ? "" : "muted"}">
          ${c.battery_ring !== false
            ? html`<div class="socwrap">
                <svg class="socring" viewBox="0 0 52 52">
                  <circle cx="26" cy="26" r="23" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="3.5"></circle>
                  ${battHasEnt && v.soc !== null ? svg`<circle cx="26" cy="26" r="23" fill="none" stroke="${battCol}" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="${bs.circ}" stroke-dashoffset="${bs.offset}" transform="rotate(-90 26 26)"></circle>` : nothing}
                </svg>
                <div class="ic round" style="color:${battCol}">
                  <ha-icon icon="mdi:battery-charging"></ha-icon>
                </div>
              </div>`
            : html`<div class="ic" style="color:${battCol};border-color:${battCol}66;background:${battCol}22">
                <ha-icon icon="mdi:battery-charging"></ha-icon>
              </div>`}
          <div class="txt"><span class="lbl">${this._t("battery")}${battHasEnt && v.soc !== null ? html` · <b style="color:${battCol}">${Math.round(v.soc)}%</b>` : nothing}</span><span class="val" style="color:${battCol}">${fmtPower(battValue)}</span>${battLabel ? html`<span class="sub" style="color:${battCol}">${battLabel}</span>` : nothing}</div>
        </div>

        <div class="infozone">
          <div class="infoitem ${c.grid_import_today_entity ? "" : "muted"}">
            <span class="infolabel">${this._t("info_grid_import_today")}</span>
            <span class="infoval" style="color:${gridCol}">${fmtEnergy(info.gridImportToday)}</span>
          </div>
          <div class="infoitem ${c.solar_energy_today_entity ? "" : "muted"}">
            <span class="infolabel">${this._t("info_solar_energy_today")}</span>
            <span class="infoval" style="color:${solarCol}">${fmtEnergy(info.solarEnergyToday)}</span>
          </div>
          <div class="infoitem ${c.current_price_entity ? "" : "muted"}">
            <span class="infolabel">${this._t("info_current_price")}</span>
            <span class="infoval">${fmtPrice(info.currentPrice)}</span>
          </div>
        </div>

        ${visual ? html`<div class="huis-wire"></div>` : nothing}
        <div class="huis ${visual ? "huis-visual" : ""}${reduceEffects ? " no-fx" : ""}" style="${visual ? "" : `left:${huisLeftPct}%`}">
          ${visual ? nothing : html`<div class="ic" style="color:${c.color_home};border-color:${c.color_home}66;background:${c.color_home}1f">
            <ha-icon icon="mdi:home"></ha-icon>
          </div>`}
          <span class="lbl">${this._t("home")}</span>
          <span class="val" style="color:${c.color_home}">${fmtPower(home)}</span>
        </div>
      </div>
    `;
  }

  connectedCallback() {
    super.connectedCallback();
    this._startChartScroll();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._flowTimer) { clearInterval(this._flowTimer); this._flowTimer = null; }
    if (this._chartTimer) { clearInterval(this._chartTimer); this._chartTimer = null; }
  }

  updated() {


    // Same trick for the chart tab body, so switching tabs (manual or auto-scroll) fades in.
    const cb = this.renderRoot?.querySelector?.(".chartbody");
    if (cb && cb.dataset.k !== this._lastChartK) {
      this._lastChartK = cb.dataset.k;
      cb.classList.remove("run");
      void cb.offsetWidth;
      cb.classList.add("run");
    }

    // Retune each flow line's animation speed via the Web Animations API instead of
    // rewriting animation-duration: changing that on a running CSS animation restarts
    // it from 0%, which looked like the line "starting over" every time the wire's
    // power (not just its direction) changed. Adjusting playbackRate on the already-
    // running animation keeps its current position and just speeds it up/slows it down.
    const BASE_ANIM_S = 1; // matches the fixed animation-duration in styles
    this.renderRoot?.querySelectorAll?.(".live[data-speed]").forEach((el) => {
      if (typeof el.getAnimations !== "function") return;
      const dur = parseFloat(el.dataset.speed);
      if (!dur || isNaN(dur)) return;
      const rate = BASE_ANIM_S / dur;
      for (const anim of el.getAnimations()) {
        if (Math.abs(anim.playbackRate - rate) > 0.01) anim.playbackRate = rate;
      }
    });
  }

  _chartTabs() {
    const c = this._config;
    return [
      { id: "price", label: this._t("tab_price"), show: !!c.price_entity || !!c.price_use_tibber_service },
      { id: "solar", label: this._t("tab_solar"), show: !!c.solar_power },
      { id: "accu", label: this._t("tab_battery"), show: !!c.battery_soc },
      {
        id: "usage",
        label: this._t("tab_usage"),
        show: !!(c.solar_power || c.battery_charge_power || c.battery_discharge_power || c.grid_power),
      },
    ].filter((t) => t.show);
  }

  _renderPrice() {
    const c = this._config;
    const mode = this._chartMode || "price";
    const tabs = this._chartTabs();
    // if selected tab is unavailable, fall back to first
    const activeMode = tabs.some((t) => t.id === mode) ? mode : (tabs[0]?.id || "price");

    const tabBar = tabs.length > 1 ? html`
      <div class="tabs">
        ${tabs.map((t) => html`
          <button class="tab ${t.id === activeMode ? "on" : ""}" @click=${() => this._setChartMode(t.id, true)}>${t.label}</button>`)}
      </div>` : nothing;

    let body;
    if (activeMode === "price") body = this._priceChart(c);
    else if (activeMode === "usage") body = this._usageChart(c);
    else body = this._historyChart(c, activeMode);

    return html`<div class="price">${tabBar}<div class="chartbody" data-k=${activeMode}>${body}</div></div>`;
  }

  _setChartMode(m, manual = false) {
    this._chartMode = m;
    if (m === "usage") this._ensureUsageHistory();
    else if (m !== "price") this._ensureHistory(m);
    // A manual click overrides auto-scroll for a while so the user's choice sticks.
    if (manual && this._config?.chart_auto_scroll) this._startChartScroll();
    this.requestUpdate();
  }

  _startChartScroll() {
    if (this._chartTimer) { clearInterval(this._chartTimer); this._chartTimer = null; }
    if (!this._config?.chart_auto_scroll) return;
    const secs = Math.max(3, this._config.chart_scroll_interval || 8);
    this._chartTimer = setInterval(() => {
      const tabs = this._chartTabs();
      if (tabs.length < 2) return;
      const mode = this._chartMode || "price";
      const idx = tabs.findIndex((t) => t.id === mode);
      const next = tabs[(idx + 1) % tabs.length];
      this._setChartMode(next.id, false);
    }, secs * 1000);
  }

  // Fetch today's history for solar/accu once, cache it.
  async _ensureHistory(mode) {
    const c = this._config;
    const entity = mode === "solar" ? c.solar_power : c.battery_soc;
    if (!entity || !this.hass) return;
    this._history = this._history || {};
    const cacheKey = mode + "|" + entity;
    // refresh at most every 5 min
    const cached = this._history[cacheKey];
    if (cached && Date.now() - cached.fetched < 300000) return;

    const start = new Date();
    start.setHours(0, 0, 0, 0);
    try {
      const url = `history/period/${start.toISOString()}?filter_entity_id=${entity}&minimal_response`;
      const res = await this.hass.callApi("GET", url);
      const arr = Array.isArray(res) && res[0] ? res[0] : [];
      const points = arr.map((s) => ({
        t: new Date(s.last_changed || s.last_updated).getTime(),
        v: parseFloat(s.state),
      })).filter((p) => !isNaN(p.v));
      this._history[cacheKey] = { fetched: Date.now(), points };
      this.requestUpdate();
    } catch (e) {
      this._history[cacheKey] = { fetched: Date.now(), points: [], error: true };
      this.requestUpdate();
    }
  }

  // Fetch the last hour of raw power history (W) for all flow entities at once — reuses
  // the same entities already configured for the flow diagram, no separate config needed.
  // One REST call for every entity (comma-separated filter_entity_id) instead of the
  // one-entity-at-a-time pattern _ensureHistory() uses for the Solar/Battery tabs.
  async _ensureUsageHistory() {
    const c = this._config;
    const entities = [c.solar_power, c.battery_charge_power, c.battery_discharge_power, c.grid_power].filter(Boolean);
    if (!entities.length || !this.hass) return;
    const cacheKey = entities.join(",");
    this._usageHistory = this._usageHistory || {};
    const cached = this._usageHistory[cacheKey];
    if (cached && Date.now() - cached.fetched < 60000) return; // refresh every minute

    const start = new Date(Date.now() - 3600000); // last hour
    try {
      const url = `history/period/${start.toISOString()}?filter_entity_id=${entities.join(",")}&minimal_response`;
      const res = await this.hass.callApi("GET", url);
      const byEntity = {};
      for (const arr of (Array.isArray(res) ? res : [])) {
        if (!Array.isArray(arr) || !arr.length) continue;
        const id = arr[0].entity_id;
        byEntity[id] = arr.map((s) => ({
          t: new Date(s.last_changed || s.last_updated).getTime(),
          v: parseFloat(s.state),
        })).filter((p) => !isNaN(p.v));
      }
      this._usageHistory[cacheKey] = { fetched: Date.now(), byEntity };
      this.requestUpdate();
    } catch (e) {
      this._usageHistory[cacheKey] = { fetched: Date.now(), byEntity: {}, error: true };
      this.requestUpdate();
    }
  }

  _usageChart(c) {
    const entities = [c.solar_power, c.battery_charge_power, c.battery_discharge_power, c.grid_power].filter(Boolean);
    const cacheKey = entities.join(",");
    const cached = this._usageHistory?.[cacheKey];
    if (!cached) this._ensureUsageHistory();
    const byEntity = cached?.byEntity || {};

    const startMs = Date.now() - 3600000;
    const now = Date.now();
    const span = Math.max(1, now - startMs);

    // Three series: solar, battery (discharge=+, charge=-, net contribution to the
    // home), and grid (positive=import, negative=export/"teruglevering").
    const series = [
      { key: c.solar_power, color: c.color_solar, name: this._t("solar") },
      { key: c.battery_discharge_power, extraKey: c.battery_charge_power, color: c.color_battery, name: this._t("battery") },
      { key: c.grid_power, color: c.color_grid, name: this._t("grid") },
    ].filter((s) => s.key || s.extraKey);

    const seriesPoints = series.map((s) => {
      if (s.extraKey !== undefined) {
        // battery: merge discharge (+) and charge (-) sample times into one net series
        const dis = (byEntity[s.key] || []);
        const chg = (byEntity[s.extraKey] || []);
        const times = [...new Set([...dis.map((p) => p.t), ...chg.map((p) => p.t)])].sort((a, b) => a - b);
        const valueAt = (arr, t) => { let last = 0; for (const p of arr) { if (p.t > t) break; last = p.v; } return last; };
        return { ...s, points: times.map((t) => ({ t, v: valueAt(dis, t) - valueAt(chg, t) })) };
      }
      return { ...s, points: (byEntity[s.key] || []).map((p) => ({ t: p.t, v: p.v })) };
    }).filter((s) => s.points.length);

    const allVals = seriesPoints.flatMap((s) => s.points.map((p) => p.v));
    const maxV = Math.max(10, ...allVals.map(Math.abs)) * 1.1;

    const pathFor = (points) => points.length
      ? points.map((p, i) => {
          const x = Math.max(0, Math.min(1, (p.t - startMs) / span)) * 100;
          const y = 50 - Math.max(-1, Math.min(1, p.v / maxV)) * 50;
          return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
        }).join(" ")
      : "";

    const labelEvery = 15; // minutes
    const labels = [];
    for (let m = 0; m <= 60; m += labelEvery) {
      const d = new Date(startMs + m * 60000);
      labels.push({ frac: (m * 60000) / span, text: d.getHours() + ":" + String(d.getMinutes()).padStart(2, "0") });
    }

    const yTicks = [1, 0.5, 0, -0.5, -1].map((f) => Math.round(maxV * f));

    return html`
      <div class="chdr">
        <span class="t">${this._t("usage_title")}</span>
        <div class="usage-legend">
          ${seriesPoints.map((s) => html`<span class="usage-legend-item"><i style="background:${s.color}"></i>${s.name}</span>`)}
        </div>
      </div>
      <div class="chart">
        <div class="yaxis">${yTicks.map((t) => html`<span>${t}</span>`)}</div>
        <div class="plot">
          ${seriesPoints.length
            ? html`<svg class="hist" viewBox="0 0 100 100" preserveAspectRatio="none">
                <line x1="0" y1="50" x2="100" y2="50" stroke="var(--divider-color, rgba(255,255,255,.2))" stroke-width="0.5" vector-effect="non-scaling-stroke"></line>
                ${seriesPoints.map((s) => svg`<path d="${pathFor(s.points)}" fill="none" stroke="${s.color}" stroke-width="1.5" vector-effect="non-scaling-stroke"></path>`)}
              </svg>`
            : html`<div class="empty">${cached?.error ? this._t("history_none") : this._t("history_loading")}</div>`}
          <div class="nowline right" data-now="${this._t("now")}" style="left:100%"></div>
        </div>
        <div class="xaxis">
          ${labels.map((l) => html`<span class="tick" style="left:${Math.min(100, l.frac * 100)}%">${l.text}</span>`)}
        </div>
      </div>
    `;
  }

  _historyChart(c, mode) {
    const entity = mode === "solar" ? c.solar_power : c.battery_soc;
    const color = mode === "solar" ? c.color_solar : c.color_battery;
    const unit = mode === "solar" ? "W" : "%";
    const title = mode === "solar" ? this._t("solar_today") : this._t("battery_today");

    const cacheKey = mode + "|" + entity;
    const cached = this._history?.[cacheKey];
    if (!cached) { this._ensureHistory(mode); }
    const points = cached?.points || [];

    // build a smooth area/line over today 00:00 -> now (axis ends at NOW)
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const startMs = start.getTime();
    const now = Date.now();
    const span = Math.max(1, now - startMs);

    let maxV = mode === "accu" ? 100 : Math.max(10, ...points.map((p) => p.v)) * 1.1;
    const path = points.length
      ? points.map((p, i) => {
          const x = Math.max(0, Math.min(1, (p.t - startMs) / span)) * 100;
          const y = 100 - Math.max(0, Math.min(1, p.v / maxV)) * 100;
          return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
        }).join(" ")
      : "";
    const areaPath = path ? `${path} L100,100 L0,100 Z` : "";

    // labels only up to the current hour; axis runs 00:00 -> now
    const nowHour = now / 3600000 - startMs / 3600000; // hours since midnight (fractional)
    const labelEvery = nowHour <= 8 ? 2 : 3;
    const labels = [];
    for (let h = 0; h <= Math.floor(nowHour); h += labelEvery) {
      labels.push({ frac: (h * 3600000) / span, text: h + ":00" });
    }
    // always show the current time at the far right
    const curD = new Date(now);
    labels.push({ frac: 1, text: curD.getHours() + ":" + String(curD.getMinutes()).padStart(2, "0") });
    const nowFrac = 1; // now is the right edge

    const cur = num(this.hass, entity);
    const yTicks = [1, 0.75, 0.5, 0.25, 0].map((f) => Math.round(maxV * f) + (mode === "accu" ? "" : ""));

    return html`
      <div class="chdr">
        <span class="t">${title}</span>
        ${cur !== null ? html`<span class="now">${this._t("now")}: <b>${mode === "accu" ? Math.round(cur) + "%" : fmtPower(cur)}</b></span>` : nothing}
      </div>
      <div class="chart">
        <div class="yaxis">${yTicks.map((t) => html`<span>${t}</span>`)}</div>
        <div class="plot">
          ${points.length
            ? html`<svg class="hist" viewBox="0 0 100 100" preserveAspectRatio="none">
                <path d="${areaPath}" fill="${color}22"></path>
                <path d="${path}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke"></path>
              </svg>`
            : html`<div class="empty">${cached?.error ? this._t("history_none") : this._t("history_loading")}</div>`}
          <div class="nowline right" data-now="${this._t("now")}" style="left:${Math.min(100, nowFrac * 100)}%"></div>
        </div>
        <div class="xaxis">
          ${labels.map((l) => html`<span class="tick" style="left:${Math.min(100, l.frac * 100)}%">${l.text}</span>`)}
        </div>
      </div>
    `;
  }

  _priceChart(c) {
    if (c.price_use_tibber_service) this._ensureTibberPrices();
    const { points: allPoints, current } = this._priceData();
    const now = Date.now();
    const hours = Math.max(8, Math.min(48, c.price_hours || 24));

    // Fixed axis: from start of current hour to +hours.
    const axisStart = new Date();
    if (c.price_start === "midnight") {
      axisStart.setHours(0, 0, 0, 0); // today 00:00
    } else {
      axisStart.setMinutes(0, 0, 0);  // start of current hour
      const lookback = Math.max(1, Math.min(12, c.price_lookback_hours ?? 2));
      axisStart.setTime(axisStart.getTime() - lookback * 3600000);
    }
    const startMs = axisStart.getTime();
    const endMs = startMs + hours * 3600000;

    // slot length from data (default hourly)
    const stepMs = allPoints.length > 1 ? (allPoints[1].t - allPoints[0].t) : 3600000;
    const slotCount = Math.max(1, Math.round((endMs - startMs) / stepMs));

    // Build fixed slots; fill with data where available
    const byTime = new Map(allPoints.map((p) => [Math.floor(p.t / stepMs) * stepMs, p.v]));
    const slots = [];
    for (let i = 0; i < slotCount; i++) {
      const t = startMs + i * stepMs;
      const key = Math.floor(t / stepMs) * stepMs;
      const v = byTime.has(key) ? byTime.get(key) : null;
      slots.push({ t, v, past: (t + stepMs) <= now, cur: t <= now && (t + stepMs) > now });
    }

    const withData = slots.filter((s) => s.v !== null);
    const maxV = withData.length ? Math.max(...withData.map((s) => s.v), 0.1) * 1.1 : 0.4;

    const nowFrac = Math.max(0, Math.min(1, (now - startMs) / (endMs - startMs)));

    // Hour labels: choose interval by width (more hours -> sparser labels)
    const labelEvery = hours <= 12 ? 2 : hours <= 24 ? 3 : 6;
    const labels = [];
    for (let h = 0; h <= hours; h += labelEvery) {
      const d = new Date(startMs + h * 3600000);
      labels.push({ frac: h / hours, text: d.getHours() + ":00" });
    }

    const yTicks = [1, 0.75, 0.5, 0.25, 0].map((f) => (maxV * f).toFixed(2).replace(".", ","));

    const sel = this._selectedSlot;
    const profile = this._activeProfile();
    const stops = this._config.price_profile !== "default" ? (profile.price_stops || c.price_stops) : c.price_stops;

    // Optional second x-axis row counting hours from now ("nu", 1, 2, 3…), off by default.
    const showRel = !!c.price_relative_hours;
    const relLabels = [];
    if (showRel) {
      const maxH = Math.max(0, Math.floor((endMs - now) / 3600000));
      let h = 0;
      while (h <= maxH) {
        const frac = (now + h * 3600000 - startMs) / (endMs - startMs);
        if (frac >= 0 && frac <= 1) {
          relLabels.push({ frac, text: h === 0 ? this._t("now").toLowerCase() : String(h) });
        }
        h += h < 10 ? 1 : h < 16 ? 2 : 3;
      }
    }

    // Optional thin marker(s) where the axis crosses local midnight, off by default. Only
    // the first one (a wide enough window can cross two midnights) says "tomorrow" — later
    // ones get the actual weekday name instead of repeating "tomorrow" incorrectly.
    const dayMarkers = [];
    if (c.price_show_day_marker) {
      const lang = resolveLang(c.language, this.hass);
      let d = new Date(startMs);
      d.setHours(24, 0, 0, 0); // next local midnight strictly after axis start
      let dayIndex = 0;
      while (d.getTime() < endMs) {
        const frac = (d.getTime() - startMs) / (endMs - startMs);
        if (frac > 0.01 && frac < 0.99) {
          const text = dayIndex === 0 ? this._t("tomorrow") : d.toLocaleDateString(lang, { weekday: "short" });
          dayMarkers.push({ frac, text });
          dayIndex++;
        }
        d = new Date(d.getTime());
        d.setDate(d.getDate() + 1);
      }
    }

    const gasPrice = num(this.hass, c.gas_price_entity);

    return html`
      <div class="chdr">
        <span class="t">${this._t("price_title")} (${hours}u)</span>
        <div class="chdr-right">
          ${sel
            ? html`<span class="now sel"><ha-icon icon="mdi:flash"></ha-icon>${new Date(sel.t).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}: <b>${sel.v.toFixed(3).replace(".", ",")}</b></span>`
            : current !== null
              ? html`<span class="now"><ha-icon icon="mdi:flash"></ha-icon>${this._t("now")}: <b>${current.toFixed(3).replace(".", ",")}</b></span>`
              : nothing}
          ${gasPrice !== null ? html`<span class="now gas"><ha-icon icon="mdi:fire"></ha-icon><b>${gasPrice.toFixed(3).replace(".", ",")}</b></span>` : nothing}
        </div>
      </div>
      <div class="chart ${showRel ? "has-rel" : ""}">
        <div class="yaxis">${yTicks.map((t) => html`<span>${t}</span>`)}</div>
        <div class="plot">
          ${profile.chart_style === "bars"
            ? this._priceBarsBody(slots, maxV, stops, sel, profile)
            : this._priceLineBody(slots, maxV, profile, sel)}
          ${dayMarkers.map((d) => html`<div class="daymarker" data-label="${d.text}" style="left:${d.frac * 100}%"></div>`)}
          <div class="nowline" data-now="${this._t("now")}" style="left:${nowFrac * 100}%"></div>
        </div>
        <div class="xaxis ${showRel ? "abs" : ""}">
          ${labels.map((l) => html`<span class="tick" style="left:${l.frac * 100}%">${l.text}</span>`)}
        </div>
        ${showRel ? html`
          <div class="xaxis rel">
            ${relLabels.map((l) => html`<span class="tick" style="left:${l.frac * 100}%">${l.text}</span>`)}
          </div>` : nothing}
      </div>
    `;
  }

  _priceBarsBody(slots, maxV, stops, sel, profile) {
    const GREY = "#6b7280";
    const radiusStyle = profile?.bar_radius ? `;border-radius:${profile.bar_radius}` : "";
    return html`
      <div class="bars">
        ${slots.map((s) => {
          if (s.v === null) {
            if (profile?.grey_unknown_value != null) {
              const h = Math.max(2, Math.min(100, (profile.grey_unknown_value / maxV) * 100));
              return html`<div class="bar unknown" style="height:${h}%;background:${GREY}${radiusStyle}"></div>`;
            }
            return html`<div class="bar empty-slot"></div>`;
          }
          const h = Math.max(2, (s.v / maxV) * 100);
          let col;
          if (profile?.highlight_now) {
            // Not price-based: a flat bar color, except the bar for the current hour.
            col = s.cur ? (profile.bar_color_now || profile.bar_color || GREY) : (profile.bar_color || GREY);
          } else if (profile?.grey_past && s.past) {
            col = GREY;
          } else {
            col = colorForValue(s.v, stops);
          }
          const isSel = sel && sel.t === s.t;
          const timeTxt = new Date(s.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          return html`<div
            class="bar ${isSel ? "sel" : ""}"
            style="height:${h}%;background:${col}${radiusStyle}"
            title="${timeTxt} — ${s.v.toFixed(3).replace(".", ",")} €/kWh"
            @mouseenter=${() => this._hoverSlot(s)}
            @mouseleave=${() => this._hoverSlot(null)}
            @click=${() => this._tapSlot(s)}
          ></div>`;
        })}
      </div>
    `;
  }

  // Smooth-line layout profiles ("line" / "line-threshold"): only the leading
  // contiguous run of known values is drawn as a curve; a trailing gap (e.g.
  // tomorrow's prices not published yet) keeps the familiar hatched placeholder.
  _priceLineBody(slots, maxV, profile, sel) {
    let runEnd = 0;
    while (runEnd < slots.length && slots[runEnd].v !== null) runEnd++;
    const run = slots.slice(0, runEnd);

    const n = Math.max(1, slots.length - 1);
    const pts = run.map((s, i) => ({
      x: (i / n) * 100,
      y: 100 - Math.max(0, Math.min(100, (s.v / maxV) * 100)),
    }));

    const pathD = pts.length ? catmullRomToBezierPath(pts) : "";
    const areaD = pathD && pts.length > 1
      ? `${pathD} L${pts[pts.length - 1].x.toFixed(2)},100 L${pts[0].x.toFixed(2)},100 Z`
      : "";

    let stroke = profile.line_color || "#7dd3fc";
    let fill = "none";
    let defs = nothing;

    if (profile.chart_style === "line-threshold" && run.length) {
      const avg = run.reduce((a, s) => a + s.v, 0) / run.length;
      const avgFrac = Math.max(0, Math.min(1, 1 - Math.min(1, avg / maxV)));
      // Soft band around the average instead of a hard cut, for a smooth orange->teal blend.
      const band = 0.14;
      const topOff = Math.max(0, avgFrac - band / 2);
      const botOff = Math.min(1, avgFrac + band / 2);
      const gradId = `efp-grad-${this._uid}`;
      defs = svg`<defs>
        <linearGradient id="${gradId}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="100">
          <stop offset="0" stop-color="${profile.color_above}"></stop>
          <stop offset="${topOff.toFixed(4)}" stop-color="${profile.color_above}"></stop>
          <stop offset="${botOff.toFixed(4)}" stop-color="${profile.color_below}"></stop>
          <stop offset="1" stop-color="${profile.color_below}"></stop>
        </linearGradient>
      </defs>`;
      stroke = `url(#${gradId})`;
      fill = `url(#${gradId})`;
    }

    return html`
      <svg class="priceline" viewBox="0 0 100 100" preserveAspectRatio="none">
        ${defs}
        ${areaD && fill !== "none" ? svg`<path d="${areaD}" fill="${fill}" fill-opacity="0.32" stroke="none"></path>` : nothing}
        ${pathD ? svg`<path d="${pathD}" fill="none" stroke="${stroke}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linecap="round"></path>` : nothing}
      </svg>
      <div class="hits">
        ${slots.map((s) => {
          if (s.v === null) return html`<div class="hit empty-slot"></div>`;
          const isSel = sel && sel.t === s.t;
          const timeTxt = new Date(s.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          return html`<div
            class="hit ${isSel ? "sel" : ""}"
            title="${timeTxt} — ${s.v.toFixed(3).replace(".", ",")} €/kWh"
            @mouseenter=${() => this._hoverSlot(s)}
            @mouseleave=${() => this._hoverSlot(null)}
            @click=${() => this._tapSlot(s)}
          ></div>`;
        })}
      </div>
    `;
  }

  _hoverSlot(s) {
    if (this._tapLock) return; // don't override a tapped selection with hover-out
    this._selectedSlot = s;
    this.requestUpdate();
  }

  _tapSlot(s) {
    if (this._selectedSlot && this._selectedSlot.t === s.t && this._tapLock) {
      this._selectedSlot = null;
      this._tapLock = false;
    } else {
      this._selectedSlot = s;
      this._tapLock = true;
    }
    this.requestUpdate();
  }

  static get styles() {
    return css`
      ha-card { padding: 12px; }
      .stack { display: flex; flex-direction: column; gap: 20px; }
      .flow { position: relative; height: clamp(280px, 45vw, 380px); min-height: 280px; }
      .housepic { position: absolute; top: 0; left: 50%; height: 100%; width: auto; max-width: none; transform: translateX(-50%); pointer-events: none; z-index: 0; }
      .wires { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 1; }
      .wire { fill: none; stroke: rgba(255,255,255,.07); stroke-width: 2.5; }
      .live { stroke-width: 2.5; fill: none; stroke-linecap: round; stroke-linejoin: round; opacity: 1; transition: opacity 1s ease; }
      .live.dashed { stroke-dasharray: 5 9; animation-name: flow; animation-duration: 1s; animation-timing-function: linear; animation-iteration-count: infinite; }
      .live.dashed.still, .live.neon.still, .live.pulse.still, .live.modern.still { stroke-dashoffset: 0; }
      .live.neon { stroke-width: 3; stroke-dasharray: 90 500; animation-name: neonsweep; animation-duration: 1s; animation-timing-function: linear; animation-iteration-count: infinite; }
      .live.solid, .live.soft-glow, .live.gradient { stroke-width: 3; }
      .live.pulse-base { stroke-width: 3; }
      .live.pulse { stroke-width: 4; stroke-dasharray: 42 520; animation-name: pulseflow; animation-duration: 1s; animation-timing-function: linear; animation-iteration-count: infinite; }
      .live.modern { stroke-width: 5; stroke-dasharray: 12 640; animation-name: modernflow; animation-duration: 1s; animation-timing-function: linear; animation-iteration-count: infinite; }
      @keyframes neonsweep { to { stroke-dashoffset: -590; } }
      @keyframes pulseflow { to { stroke-dashoffset: -562; } }
      @keyframes modernflow { to { stroke-dashoffset: -652; } }
      @media (prefers-reduced-motion: reduce) {
        .live.dashed, .live.neon, .live.pulse, .live.modern { animation: none !important; }
      }
      .live.fade-in { opacity: 1; }
      .live.fade-out { opacity: 0; }
      .live.dir-swap { transition: opacity .3s ease; }
      @keyframes flow { to { stroke-dashoffset: -14; } }
      .node { position: absolute; display: flex; align-items: center; gap: 12px; z-index: 2; }
      .node.tl { left: 12px; top: 16px; }
      .node.tr { right: 12px; top: 16px; flex-direction: row-reverse; text-align: right; }
      .node.bl { left: 12px; bottom: 16px; }
      .node.muted { opacity: .55; }
      .node.muted .val, .node.muted .sub { opacity: .8; }
      .node .ic { width: 72px; height: 72px; border-radius: 18px; flex: 0 0 auto; display: flex; align-items: center; justify-content: center; border: 1.5px solid transparent; }
      .node .ic ha-icon { --mdc-icon-size: 38px; }
      .txt { display: flex; flex-direction: column; gap: 1px; }
      .node.tr .txt { align-items: flex-end; }
      .txt .lbl { font-size: 14px; color: var(--secondary-text-color); }
      .txt .val { font-size: 23px; font-weight: 700; line-height: 1.1; }
      .txt .sub { font-size: 12px; text-transform: uppercase; letter-spacing: .4px; opacity: .85; }
      .txt .grid-voltage { margin-top: 2px; font-size: 13px; font-weight: 700; letter-spacing: 0; text-transform: none; opacity: 1; }
      .socwrap { position: relative; width: 72px; height: 72px; flex: 0 0 auto; }
      .socwrap .ic { position: absolute; inset: 0; }
      .socwrap .ic.round { border: none; background: none; border-radius: 50%; }
      .socring { position: absolute; inset: 0; }


      .infozone { position: absolute; right: 12px; bottom: 16px; z-index: 2; display: flex; flex-direction: column; gap: 6px; min-width: 170px; max-width: 230px; padding: 11px 13px; border: 1px solid rgba(255,255,255,.12); border-radius: 14px; background: color-mix(in srgb, var(--card-background-color, #1c1c2e) 86%, transparent); box-shadow: 0 3px 12px rgba(0,0,0,.18); text-align: right; }
      .infoitem { display: flex; flex-direction: column; gap: 1px; }
      .infoitem.muted { opacity: .55; }
      .infolabel { font-size: 12px; color: var(--secondary-text-color); }
      .infoval { font-size: 18px; font-weight: 700; color: var(--info-color, #7dd3fc); white-space: nowrap; }

      .huis { position: absolute; left: 50%; top: 54.7%; transform: translate(-50%, -29px); z-index: 3; display: flex; flex-direction: column; align-items: center; gap: 2px; text-align: center; }
      .huis.huis-visual { left: 50%; top: 50%; align-items: flex-end; text-align: right; transform: translate(calc(-100% - 110px), -50%); }
      .huis.huis-visual .lbl, .huis.huis-visual .val { text-shadow: 0 1px 3px rgba(0,0,0,.8), 0 0 6px rgba(0,0,0,.6); }
      .huis.huis-visual.no-fx .lbl, .huis.huis-visual.no-fx .val { text-shadow: none; }
      .huis-wire { position: absolute; top: 50%; left: calc(50% - 110px); width: 15px; height: 2px; background: rgba(255,255,255,.12); transform: translateY(-50%); pointer-events: none; z-index: 0; }
      .huis .ic { width: 88px; height: 88px; border-radius: 22px; border: 1.5px solid transparent; display: flex; align-items: center; justify-content: center; }
      .huis .ic ha-icon { --mdc-icon-size: 46px; }
      .huis .lbl { font-size: 14px; color: var(--secondary-text-color); }
      .huis .val { font-size: 25px; font-weight: 700; }

      .chdr { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 14px; }
      .chdr .t { font-size: 18px; font-weight: 600; color: var(--primary-text-color); }
      .chdr-right { display: flex; align-items: baseline; gap: 12px; }
      .chdr .now { display: inline-flex; align-items: center; gap: 4px; }
      .chdr .now ha-icon { --mdc-icon-size: 13px; color: var(--info-color, #7dd3fc); }
      .chdr .now.gas ha-icon { color: var(--warning-color, #f5a623); }
      .chdr .now.gas b { color: var(--warning-color, #f5a623); }
      .tabs { display: flex; gap: 8px; margin-bottom: 14px; }
      .tab { cursor: pointer; border: 1px solid var(--divider-color); background: transparent; color: var(--secondary-text-color); border-radius: 999px; padding: 5px 16px; font-size: 14px; transition: all .2s; }
      .tab.on { background: var(--primary-color); border-color: var(--primary-color); color: var(--text-primary-color, #fff); }
      .chartbody.run { animation: chartfade .4s ease; }
      @keyframes chartfade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
      .hist { position: absolute; inset: 0; width: 100%; height: 100%; }
      .chdr .now { font-size: 16px; color: var(--secondary-text-color); }
      .chdr .now b { color: var(--info-color, #7dd3fc); font-weight: 700; }
      .chart { position: relative; height: 290px; padding-left: 42px; }
      .chart.has-rel { height: 316px; }
      .yaxis { position: absolute; left: 0; top: 0; bottom: 42px; width: 36px; display: flex; flex-direction: column; justify-content: space-between; font-size: 12px; color: var(--secondary-text-color); text-align: right; }
      .chart.has-rel .yaxis { bottom: 58px; }
      .plot { position: absolute; left: 42px; right: 0; top: 0; bottom: 42px; }
      .chart.has-rel .plot { bottom: 58px; }
      .bars { position: absolute; inset: 0; display: flex; align-items: flex-end; gap: 1px; }
      .bar { flex: 1; border-radius: 0; cursor: pointer; transition: opacity .15s; }
      .bar:hover { opacity: .8; }
      .bar.sel { outline: 1.5px solid var(--primary-text-color); outline-offset: -1px; }
      .chdr .now.sel b { color: var(--primary-color); }
      .bar.empty-slot { background: repeating-linear-gradient(45deg, rgba(255,255,255,.03), rgba(255,255,255,.03) 3px, transparent 3px, transparent 6px); height: 100%; border-radius: 0; align-self: stretch; }
      .bar.unknown { cursor: default; opacity: .55; }
      .bar.unknown:hover { opacity: .55; }
      .priceline { position: absolute; inset: 0; width: 100%; height: 100%; }
      .hits { position: absolute; inset: 0; display: flex; align-items: stretch; gap: 1px; }
      .hit { flex: 1; cursor: pointer; background: transparent; border-radius: 2px; }
      .hit:hover { background: rgba(255,255,255,.06); }
      .hit.sel { background: rgba(255,255,255,.12); }
      .hit.empty-slot { background: repeating-linear-gradient(45deg, rgba(255,255,255,.03), rgba(255,255,255,.03) 3px, transparent 3px, transparent 6px); cursor: default; }
      .nowline { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--info-color, #7dd3fc); box-shadow: 0 0 8px var(--info-color, #7dd3fc); }
      .nowline::before { content: attr(data-now); position: absolute; top: -2px; left: 3px; font-size: 12px; background: var(--info-color, #7dd3fc); color: #0a1420; padding: 1px 4px; border-radius: 3px; font-weight: 700; }
      .nowline.right::before { left: auto; right: 3px; }
      .daymarker { position: absolute; top: 0; bottom: 0; width: 0; border-left: 1px dashed rgba(255,255,255,.28); }
      .daymarker::before { content: attr(data-label); position: absolute; top: -2px; left: 4px; font-size: 12px; color: var(--secondary-text-color); white-space: nowrap; }
      .xaxis { position: absolute; left: 42px; right: 0; bottom: 14px; height: 16px; }
      .xaxis.abs { bottom: 32px; }
      .xaxis.rel { bottom: 10px; }
      .xaxis.rel .tick { opacity: .75; }
      .xaxis.rel .tick::before { display: none; }
      .xaxis .tick { position: absolute; transform: translateX(-50%); font-size: 12px; color: var(--secondary-text-color); white-space: nowrap; }
      .xaxis .tick:last-child { transform: translateX(-100%); }
      .xaxis .tick::before { content: ""; position: absolute; top: -6px; left: 50%; width: 1px; height: 4px; background: var(--divider-color, rgba(255,255,255,.2)); }

      /* Usage tab: last-hour power (W) line chart, split by source. */
      .usage-legend { display: flex; align-items: baseline; gap: 10px; }
      .usage-legend-item { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--secondary-text-color); }
      .usage-legend-item i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; }

      @media (max-width: 520px) {
        .flow { height: 280px; }
        .node { gap: 8px; }
        .node .ic, .socwrap { width: 52px; height: 52px; border-radius: 14px; }
        .node .ic ha-icon { --mdc-icon-size: 28px; }
        .txt .lbl { font-size: 11px; }
        .txt .val { font-size: 18px; }
        .txt .sub { font-size: 10px; }
        .txt .grid-voltage { font-size: 11px; }
        .huis .ic { width: 62px; height: 62px; border-radius: 16px; }
        .huis .ic ha-icon { --mdc-icon-size: 32px; }
        .huis .val { font-size: 20px; }
        .infozone { right: 8px; bottom: 10px; min-width: 132px; padding: 8px 10px; gap: 4px; }
        .infolabel { font-size: 10px; }
        .infoval { font-size: 14px; }
        .chdr .t { font-size: 15px; }
        .chdr .now { font-size: 13px; }
        .tab { padding: 4px 10px; font-size: 12px; }
        .chart { height: 220px; padding-left: 36px; }
        .chart.has-rel { height: 244px; }
        .yaxis { width: 30px; bottom: 38px; font-size: 10px; }
        .chart.has-rel .yaxis { bottom: 54px; }
        .plot { left: 36px; bottom: 38px; }
        .chart.has-rel .plot { bottom: 54px; }
        .xaxis { left: 36px; bottom: 12px; }
        .xaxis.abs { bottom: 28px; }
        .xaxis .tick { font-size: 10px; }
      }
    `;
  }
}

customElements.define("maurits-energy-flow-card", MauritsEnergyFlowCard);

console.info("%c maurits-energy-flow-card %c v1.0.0 ", "background:#7dd3fc;color:#0a1420;font-weight:700", "background:#333;color:#fff");

window.customCards = window.customCards || [];
window.customCards.push({
  type: "maurits-energy-flow-card",
  name: "Maurits Energy Flow Card",
  description: "Compact energy flow (solar, battery, home and grid) plus dynamic electricity and gas price charts.",
  preview: true,
  documentationURL: "https://github.com/dennisbest85/energy-flow-price-card",
});
