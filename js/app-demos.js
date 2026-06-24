// Built-in example diagrams.
//
// These methods were split out of app.js to keep the App class manageable.
// They are mixed onto App.prototype below, so every call site is unchanged
// (this._x(), window.app._x()). Load order in index.html: after app.js, which
// defines class App; the DOMContentLoaded handler that does `new App()` runs
// only after every sync <script> has executed, so the prototype is complete
// by construction time.

class AppDemos {
  // ── Example diagrams ──────────────────────────────────────────────────────
  //
  // Each demo is a self-contained systems model that produces genuinely
  // emergent behaviour — not just a wiring sampler. They lean on the engine's
  // formula rates, modifiers, registers, delays, queues, traders and coloured
  // resources, and each ships with a titled group, an explanatory note and an
  // on-canvas chart so it reads at a glance. Verified headlessly against the
  // engine before shipping; see the parameters on each for the tuned values.

  // Small builder helpers shared by the demos below.
  _demo() {
    const d = this.diagram;
    return {
      d,
      node: (type, x, y, label, f) => {
        const n = d.addNode(new MNode(type, x, y));
        if (label != null) n.label = label;
        if (f) f(n);
        return n;
      },
      res: (s, t, f) => { const c = d.addConnection(new MConnection(s.id, t.id)); if (f) f(c); return c; },
      st: (s, t, f) => { const c = d.addConnection(new MConnection(s.id, t.id, ConnectionType.STATE)); if (f) f(c); return c; },
      group: (x, y, w, h, label, color) => { const g = d.addGroup(new MGroup(x, y, w, h)); g.label = label; if (color) g.color = color; return g; },
      note: (x, y, w, h, text) => { const n = d.addNote(new MNote(x, y)); n.w = w; n.h = h; n.text = text; return n; },
      chart: (x, y, w, h, label, ids) => { const c = d.addChart(new MChart(x, y)); c.w = w; c.h = h; c.label = label; c.nodeIds = ids; return c; },
    };
  }

  // 1 — PREDATOR & PREY: two coupled populations settle into a stable limit
  // cycle. Rabbits breed logistically; foxes eat rabbits and starve without
  // them. Tunable via the breedRate / carrying / hunt parameters.
  _demoEcosystem() {
    const b = this._demo();
    b.d.params = { breedRate: 0.45, carrying: 200, hunt: 0.008 };
    b.group(250, 70, 700, 590, 'Predator–Prey Ecosystem', '#7cb342');

    const births = b.node(NodeType.REGISTER, 470, 165, 'births',
      n => { n.formula = 'Math.round(breedRate * prey * (1 - prey/carrying))'; });
    const rabbits = b.node(NodeType.POOL, 380, 340, 'Rabbits',
      n => { n.setCount(80, '#7cb342'); n.capacity = 500; });
    const foxes = b.node(NodeType.POOL, 760, 340, 'Foxes', n => n.setCount(20, '#ef5350'));

    b.st(rabbits, births, c => { c.variableName = 'prey'; c.label = 'prey'; });
    b.st(births, rabbits, c => { c.modifier = true; c.modFactor = 1; c.label = 'breed'; });
    b.st(foxes, rabbits, c => { c.variableName = 'pred'; c.label = 'pred'; });
    b.res(rabbits, foxes, c => { c.rateMode = RateMode.FORMULA; c.formula = 'hunt * prey * pred'; c.label = 'hunt'; });
    b.st(foxes, foxes, c => { c.modifier = true; c.modFactor = -0.28; c.label = 'starve'; });

    b.chart(370, 470, 470, 170, 'Populations', [rabbits.id, foxes.id]);
    b.note(980, 165, 250, 250,
      'Foxes eat rabbits; rabbits breed (slowing as they crowd their range); ' +
      'foxes starve without food.\n\nNo target was set, yet the two populations ' +
      'lock into a self-sustaining oscillation, foxes peaking just after rabbits. ' +
      'Press Run and watch the cycle.');
    this.renderer.render();
  }

  // 2 — EPIDEMIC (SIR): the textbook outbreak curve. Infections peak exactly as
  // the effective reproduction number Rₑ falls through 1 (herd immunity); the
  // run halts when the outbreak fades.
  _demoEpidemic() {
    const b = this._demo();
    b.d.params = { beta: 0.6, gamma: 0.18, N: 600 };
    b.group(240, 70, 840, 540, 'Epidemic (SIR Model)', '#ef5350');

    const reff = b.node(NodeType.REGISTER, 640, 165, 'Reff',
      n => { n.formula = '(beta/gamma) * S / N'; });
    const sus = b.node(NodeType.POOL, 380, 340, 'Susceptible', n => n.setCount(590, '#42a5f5'));
    const inf = b.node(NodeType.POOL, 640, 340, 'Infected', n => {
      n.setCount(10, '#ef5350');
      n.endEnabled = true; n.endOperator = '<='; n.endValue = 3;   // outbreak fades → halt
    });
    const rec = b.node(NodeType.POOL, 900, 340, 'Recovered', n => n.setCount(0, '#66bb6a'));

    b.res(sus, inf, c => { c.rateMode = RateMode.FORMULA; c.formula = 'beta * S * I / N'; c.label = 'infect'; });
    b.res(inf, rec, c => { c.rateMode = RateMode.FORMULA; c.formula = 'gamma * I'; c.label = 'recover'; });
    b.st(sus, reff, c => { c.variableName = 'S'; c.label = 'S'; });
    b.st(inf, sus, c => { c.variableName = 'I'; c.label = 'I'; });

    b.chart(380, 470, 520, 150, 'S / I / R', [sus.id, inf.id, rec.id]);
    b.note(1110, 165, 250, 270,
      'Each infected person infects susceptibles at rate β·S·I/N and recovers at ' +
      'rate γ·I.\n\nWatch infections crest the instant Rₑ drops below 1, the herd-' +
      'immunity threshold. A slice of the population is never infected. ' +
      'Open the Timeline to trace all three curves.');
    this.renderer.render();
  }

  // 3 — SUPPLY CHAIN: a production pipeline. Ore is smelted 2:1 into ingots,
  // shipped through a 3-step delay, then sold. The first sale lands only after
  // the pipeline fills — visible latency, then steady throughput.
  _demoSupplyChain() {
    const b = this._demo();
    b.d.resourceTypes = [{ name: 'Ore', color: '#90a4ae' }, { name: 'Ingot', color: '#ffa726' }];
    b.group(170, 200, 1010, 220, 'Factory Supply Chain', '#ffa726');

    const mine = b.node(NodeType.SOURCE, 250, 310, 'Mine', n => { n.resourceColor = '#90a4ae'; });
    const ore = b.node(NodeType.POOL, 430, 310, 'Ore', n => { n.capacity = 12; });
    const smelter = b.node(NodeType.CONVERTER, 610, 310, 'Smelter',
      n => { n.inputAmount = 2; n.outputColor = '#ffa726'; });
    const ingots = b.node(NodeType.POOL, 790, 310, 'Ingots');
    const shipping = b.node(NodeType.DELAY, 960, 310, 'Shipping', n => { n.delay = 3; });
    const market = b.node(NodeType.DRAIN, 1120, 310, 'Market');

    b.res(mine, ore, c => { c.rate = 2; });
    b.res(ore, smelter, c => { c.rate = 2; c.label = '2 ore'; });
    b.res(smelter, ingots, c => { c.rate = 1; c.label = '1 ingot'; });
    b.res(ingots, shipping, c => { c.rate = 1; });
    b.res(shipping, market, c => { c.rate = 1; });

    b.chart(250, 470, 560, 180, 'Ore · Ingots · Sold', [ore.id, ingots.id, market.id]);
    b.note(880, 470, 300, 180,
      'The Smelter converts 2 ore → 1 ingot; Shipping is a 3-step delay before ' +
      'the Market buys.\n\nNothing sells until the pipeline fills. Then output ' +
      'holds steady at 1/step. Speed up the Mine and the Ore buffer (cap 12) ' +
      'backs up: a bottleneck.');
    this.renderer.render();
  }

  // 4 — BARTER ECONOMY: two towns each make one good and swap for the other
  // through a Trader (an atomic 2-grain ⇄ 2-timber exchange). Each storehouse
  // ends up holding BOTH colours — the barter made visible.
  _demoTradeNetwork() {
    const b = this._demo();
    b.d.resourceTypes = [{ name: 'Grain', color: '#fdd835' }, { name: 'Timber', color: '#8d6e63' }];
    b.group(220, 120, 770, 540, 'Barter Economy', '#8d6e63');

    const farm = b.node(NodeType.SOURCE, 300, 250, 'Farmland', n => { n.resourceColor = '#fdd835'; });
    const granary = b.node(NodeType.POOL, 510, 250, 'Granary', n => { n.capacity = 20; n.setCount(10, '#fdd835'); });
    const builders = b.node(NodeType.DRAIN, 770, 250, 'Builders');
    const forest = b.node(NodeType.SOURCE, 300, 530, 'Forest', n => { n.resourceColor = '#8d6e63'; });
    const yard = b.node(NodeType.POOL, 510, 530, 'Lumberyard', n => { n.capacity = 20; n.setCount(10, '#8d6e63'); });
    const sawmill = b.node(NodeType.DRAIN, 770, 530, 'Sawmill');
    const market = b.node(NodeType.TRADER, 640, 390, 'Market');

    b.res(farm, granary, c => { c.rate = 3; });
    b.res(forest, yard, c => { c.rate = 3; });
    // Trader: Granary pays 2 grain → Lumberyard pays 2 timber back.
    b.res(granary, market, c => { c.rate = 2; c.colorFilter = '#fdd835'; c.label = '2 grain'; });
    b.res(market, yard, c => { c.rate = 2; c.colorFilter = '#8d6e63'; c.label = '2 timber'; });
    // Each town consumes the good it imported.
    b.res(granary, builders, c => { c.rate = 2; c.colorFilter = '#8d6e63'; c.label = 'timber'; });
    b.res(yard, sawmill, c => { c.rate = 2; c.colorFilter = '#fdd835'; c.label = 'grain'; });

    b.note(1030, 250, 250, 280,
      'The Granary makes grain, the Lumberyard makes timber, but each needs the ' +
      "other.\n\nThe Market is a Trader: it swaps 2 grain for 2 timber atomically " +
      '(all-or-nothing). Imported goods are then consumed. Select a storehouse. ' +
      'it now holds BOTH colours, proof the barter flowed.');
    this.renderer.render();
  }

  // 5 — SERVICE DESK: a single-server queue with random (Poisson) arrivals.
  // When arrivals outpace the one server the line grows; when they ease it
  // clears — the M/D/1 queue behind every checkout and call centre.
  _demoQueue() {
    const b = this._demo();
    b.group(260, 180, 600, 230, 'Single-Server Queue', '#7c83ff');

    const arrivals = b.node(NodeType.SOURCE, 360, 290, 'Arrivals', n => { n.resourceColor = '#7c83ff'; });
    const desk = b.node(NodeType.QUEUE, 560, 290, 'Service Desk', n => { n.processTime = 2; });
    const served = b.node(NodeType.DRAIN, 760, 290, 'Served');

    b.res(arrivals, desk, c => {
      c.rateMode = RateMode.DISTRIBUTION; c.distType = 'poisson'; c.distParam1 = 0.35; c.label = 'Poisson';
    });
    b.res(desk, served, c => { c.rate = 1; });

    b.chart(330, 470, 480, 160, 'Waiting · Served', [desk.id, served.id]);
    b.note(900, 250, 270, 220,
      'Customers arrive at random (Poisson, ~0.35/step); one server takes 2 steps ' +
      'each.\n\nThe line breathes, building when arrivals cluster, draining when ' +
      'they thin. Run it again for a different trace, or open Batch Analysis to ' +
      'see the distribution of queue lengths across many runs.');
    this.renderer.render();
  }

  // 6 — F2P MOBILE GAME ECONOMY: a full free-to-play live-ops loop. Energy
  // regenerates and is spent to clear levels (minting Gold + XP); a sqrt level
  // curve gates Elite content via an activator; a probabilistic gacha gate
  // splits loot boxes into rarity tiers; DAU is a birth-death process feeding
  // an IAP gem faucet. Faucets and sinks self-balance into clean limit cycles.
  _demoF2P() {
    const b = this._demo();
    b.d.params = {
      regenRate: 5,        // energy regenerated per step
      goldPerWin: 16,      // soft currency minted per level cleared
      xpPerWin: 11,        // xp minted per level cleared
      payerRate: 6,        // payers per 1000 DAU per step (IAP conversion)
      installRate: 70,     // gross new installs per acquisition pulse
      churnRate: 0.028,    // fraction of DAU that churns each step
    };

    // Resource palette — one distinct colour per economy type.
    const C_ENERGY='#42a5f5', C_GOLD='#fdd835', C_GEM='#ab47bc', C_XP='#26c6da';
    const C_COMMON='#90a4ae', C_RARE='#29b6f6', C_EPIC='#ba68c8', C_LEG='#ffa726';
    const C_WIN='#66bb6a', C_GEAR='#7e57c2', C_PLAYER='#26a69a', C_PASS='#ec407a';
    b.d.resourceTypes = [
      {name:'Energy',color:C_ENERGY},{name:'Gold',color:C_GOLD},{name:'Gems',color:C_GEM},
      {name:'XP',color:C_XP},{name:'Common',color:C_COMMON},{name:'Rare',color:C_RARE},
      {name:'Epic',color:C_EPIC},{name:'Legendary',color:C_LEG},{name:'Players',color:C_PLAYER},
    ];

    // ── GROUPS ────────────────────────────────────────────────────────────────
    b.group(60,   60, 900, 480, 'Core Gameplay Loop',        '#42a5f5');
    b.group(60,  580, 900, 420, 'Gacha / Loot Boxes',        '#ab47bc');
    b.group(1000, 60, 860, 480, 'Progression & Content',     '#26c6da');
    b.group(1000,580, 860, 420, 'Economy · Retention · IAP', '#fdd835');

    // ── CORE GAMEPLAY LOOP ──────────────────────────────────────────────────────
    // Energy regenerates over time and is spent to clear levels. Watch-an-ad gives a
    // stochastic energy refill (dice + chance) on top of passive regen.
    const regen  = b.node(NodeType.SOURCE,    110, 170, 'Stamina Regen', n=>{ n.resourceColor=C_ENERGY; });
    const adWatch= b.node(NodeType.SOURCE,    110, 320, 'Watch Ad',      n=>{ n.resourceColor=C_ENERGY; });
    const energy = b.node(NodeType.POOL,      330, 170, 'Energy', n=>{ n.setCount(40, C_ENERGY); n.capacity=40; });
    const play   = b.node(NodeType.CONVERTER, 540, 170, 'Play Level', n=>{ n.inputAmount=6; n.outputColor=C_WIN; });
    const wins   = b.node(NodeType.POOL,      760, 170, 'Levels Cleared', n=>{ n.capacity=999999; });

    b.res(regen,  energy, c=>{ c.rateMode=RateMode.FORMULA; c.formula='regenRate'; c.label='+regen'; });
    b.res(adWatch,energy, c=>{ c.rateMode=RateMode.DICE; c.dice='1d6'; c.chance=40; c.label='ad 1d6 @40%'; });
    b.res(energy, play,   c=>{ c.rate=6; c.label='6 energy'; });
    b.res(play,   wins,   c=>{ c.rate=1; c.label='clear'; });

    // Faucets: each cleared level mints Gold + XP (delta modifiers off the win count).
    const gold = b.node(NodeType.POOL, 330, 360, 'Gold', n=>{ n.setCount(80, C_GOLD); n.capacity=999999; });
    const xp   = b.node(NodeType.POOL, 760, 360, 'XP',   n=>{ n.setCount(0,  C_XP);   n.capacity=999999; });
    b.st(wins, gold, c=>{ c.modifier=true; c.modMode='delta'; c.modFormula='goldPerWin'; c.label='+gold/win'; });
    b.st(wins, xp,   c=>{ c.modifier=true; c.modMode='delta'; c.modFormula='xpPerWin';   c.label='+xp/win'; });

    // Win-streak register (informational): each win adds, drives nothing harmful.
    const streak = b.node(NodeType.REGISTER, 560, 360, 'streak', n=>{ n.formula='min(20, floor(winCount/3))'; });
    b.st(wins, streak, c=>{ c.variableName='winCount'; c.label='winCount'; });

    // ── PROGRESSION & CONTENT ───────────────────────────────────────────────────
    // XP → Level on a rising sqrt curve. Level gates Elite content via an activator.
    const level = b.node(NodeType.REGISTER, 1080, 160, 'level', n=>{ n.formula='floor( sqrt(xpTotal / 60) ) + 1'; });
    b.st(xp, level, c=>{ c.variableName='xpTotal'; c.label='xpTotal'; });

    // Account power: derived from rarity holdings + gear (the strength meta-metric).
    const power = b.node(NodeType.REGISTER, 1320, 160, 'power',
      n=>{ n.formula='cCommon + cRare*4 + cEpic*16 + cLeg*64 + gearTiers*40 + eliteHeld*8'; });

    // Elite content unlocks at level >= 4: energy spills into an Elite reserve, a
    // gated Elite converter mints high-tier loot.
    const eliteEnergy = b.node(NodeType.POOL,      1080, 320, 'Elite Energy', n=>{ n.setCount(0,C_ENERGY); n.capacity=60; });
    const eliteRun    = b.node(NodeType.CONVERTER, 1320, 320, 'Elite Stage',  n=>{ n.inputAmount=8; n.outputColor=C_LEG; });
    const eliteLoot   = b.node(NodeType.POOL,      1560, 320, 'Elite Loot',   n=>{ n.capacity=999999; });
    b.res(energy, eliteEnergy, c=>{ c.rate=3; c.condEnabled=true; c.condRefMode='variable'; c.condVariable='level'; c.condOperator='>='; c.condValue=4; c.label='if Lv>=4'; });
    b.res(eliteEnergy, eliteRun, c=>{ c.rate=8; c.label='8 energy'; });
    b.res(eliteRun,    eliteLoot,c=>{ c.rate=2; c.label='elite loot'; });
    b.st(level, eliteRun, c=>{ c.activator=true; c.actOperator='>='; c.actValue=4; c.label='Lv>=4'; });
    b.st(eliteLoot, power, c=>{ c.variableName='eliteHeld'; c.label='eliteHeld'; });

    // Battle Pass: every win contributes XP to a pass tier (capped register).
    const passXP  = b.node(NodeType.POOL,      1080, 460, 'Pass XP', n=>{ n.setCount(0,C_PASS); n.capacity=999999; });
    const passTier= b.node(NodeType.REGISTER,  1320, 460, 'passTier', n=>{ n.formula='min(30, floor(passPts/40))'; });
    b.st(wins, passXP, c=>{ c.modifier=true; c.modMode='delta'; c.modFactor=10; c.label='+10/win'; });
    b.st(passXP, passTier, c=>{ c.variableName='passPts'; c.label='passPts'; });

    // ── GACHA / LOOT BOXES ──────────────────────────────────────────────────────
    // Gems buy pull tickets; a box-open DELAY then a probabilistic GATE split each
    // box into rarity tiers (70/22/7/1%).
    const gems     = b.node(NodeType.POOL,  110, 690, 'Gems', n=>{ n.setCount(50, C_GEM); n.capacity=9999; });
    const pullBuf  = b.node(NodeType.POOL,  300, 690, 'Pull Tickets', n=>{ n.setCount(0, C_COMMON); n.capacity=400; });
    const openBox  = b.node(NodeType.DELAY, 480, 690, 'Open Box', n=>{ n.delay=2; });
    const pullGate = b.node(NodeType.GATE,  650, 690, 'Rarity Roll', n=>{ n.gateMode='probabilistic'; });
    b.res(gems,    pullBuf, c=>{ c.rate=2; c.label='spend gems'; });
    b.res(pullBuf, openBox, c=>{ c.rate=2; c.label='open'; });
    b.res(openBox, pullGate,c=>{ c.rate=4; c.label='roll'; });

    const common = b.node(NodeType.POOL, 820, 610, 'Common',    n=>{ n.capacity=999999; });
    const rare   = b.node(NodeType.POOL, 820, 690, 'Rare',      n=>{ n.capacity=999999; });
    const epic   = b.node(NodeType.POOL, 820, 770, 'Epic',      n=>{ n.capacity=999999; });
    const legend = b.node(NodeType.POOL, 820, 900, 'Legendary', n=>{ n.setCount(0,C_LEG); n.capacity=999999; });
    b.res(pullGate, common, c=>{ c.weight=70; c.label='70%'; });
    b.res(pullGate, rare,   c=>{ c.weight=22; c.label='22%'; });
    b.res(pullGate, epic,   c=>{ c.weight=7;  c.label='7%'; });
    b.res(pullGate, legend, c=>{ c.weight=1;  c.label='1%'; });

    // Publish rarity holdings to the power register.
    b.st(common, power, c=>{ c.variableName='cCommon'; c.label='cCommon'; });
    b.st(rare,   power, c=>{ c.variableName='cRare';   c.label='cRare'; });
    b.st(epic,   power, c=>{ c.variableName='cEpic';   c.label='cEpic'; });
    b.st(legend, power, c=>{ c.variableName='cLeg';    c.label='cLeg'; });

    // Dust sink: duplicate Commons get salvaged (a drain) once a stockpile builds.
    const dust = b.node(NodeType.DRAIN, 560, 900, 'Salvage Dust');
    b.res(common, dust, c=>{ c.rate=2; c.condEnabled=true; c.condOperator='>'; c.condValue=40; c.label='if Common>40'; });

    // ── ECONOMY · RETENTION · IAP ────────────────────────────────────────────────
    // Gold sink: a crafting converter spends gold into Gear Tiers (account power).
    const craft = b.node(NodeType.CONVERTER, 1060, 690, 'Crafting', n=>{ n.inputAmount=24; n.outputColor=C_GEAR; });
    const gear  = b.node(NodeType.POOL,      1260, 690, 'Gear Tiers', n=>{ n.setCount(0,C_GEAR); n.capacity=999; });
    b.res(gold,  craft, c=>{ c.rate=24; c.condEnabled=true; c.condOperator='>='; c.condValue=120; c.label='if gold>=120'; });
    b.res(craft, gear,  c=>{ c.rate=1; c.label='+gear'; });
    b.st(gear, power, c=>{ c.variableName='gearTiers'; c.label='gearTiers'; });

    // Active players (DAU) as a birth–death process: new installs pulse in (scaled
    // by content depth = level), churn drains a fraction each step → it stabilises.
    const installs = b.node(NodeType.SOURCE, 1060, 840, 'New Installs', n=>{ n.resourceColor=C_PLAYER; });
    const dau      = b.node(NodeType.POOL,   1280, 840, 'Active Players', n=>{ n.setCount(700,C_PLAYER); n.capacity=8000; });
    const churn    = b.node(NodeType.DRAIN,  1500, 840, 'Churned');
    b.res(installs, dau, c=>{ c.rateMode=RateMode.FORMULA; c.formula='round(installRate * (1 + level/6))'; c.interval=3; c.label='installs'; });
    b.res(dau, churn, c=>{ c.flowMode='push'; c.rateMode=RateMode.FORMULA; c.formula='round(dauVal * churnRate)'; c.label='churn'; });
    b.st(dau, dau, c=>{ c.variableName='dauVal'; c.label='dauVal'; });

    // IAP: a small % of DAU convert and pay → buy Gems (faucet scaled by DAU).
    const iap = b.node(NodeType.SOURCE, 1560, 690, 'IAP Shop', n=>{ n.resourceColor=C_GEM; });
    b.res(iap, gems, c=>{ c.rateMode=RateMode.FORMULA; c.formula='round(dauVal * payerRate / 1000)'; c.label='IAP gems'; });

    // Whale sink: high spenders burn surplus gems on cosmetics (a self-regulating
    // formula drain), keeping gems cycling around a setpoint instead of exploding.
    const skins = b.node(NodeType.DRAIN, 110, 840, 'Cosmetic Skins');
    b.res(gems, skins, c=>{ c.rateMode=RateMode.FORMULA; c.formula='round((gemBal-30) * 0.5)'; c.condEnabled=true; c.condRefMode='variable'; c.condVariable='gemBal'; c.condOperator='>'; c.condValue=30; c.label='whale spend'; });
    b.st(gems, skins, c=>{ c.variableName='gemBal'; c.label='gemBal'; });

    // Daily login retention pulse: returning players top up gems.
    const login = b.node(NodeType.SOURCE, 300, 840, 'Daily Login', n=>{ n.resourceColor=C_GEM; });
    b.res(login, gems,  c=>{ c.rate=10; c.interval=7; c.label='login +10 gems'; });

    // ── CHARTS & NOTES ──────────────────────────────────────────────────────────
    b.chart(110, 420, 420, 110, 'Energy · Gold · XP', [energy.id, gold.id, xp.id]);
    b.chart(560, 610, 240, 100, 'Rarity drops', [common.id, rare.id, epic.id, legend.id]);
    b.chart(1620, 60, 220, 200, 'Power · DAU · Level', [power.id, dau.id, level.id]);
    b.chart(1480, 460, 360, 70, 'Gems · Gear', [gems.id, gear.id]);

    b.note(560, 80, 380, 75,
      'A full free-to-play live-ops economy. Energy regenerates (plus stochastic ' +
      'Watch-Ad refills) and is spent to clear levels, minting Gold and XP.');
    b.note(1080, 80, 470, 60,
      'XP raises Level on a rising sqrt curve; Level >= 4 unlocks the Elite Stage ' +
      '(activator). Power aggregates rarity + gear + elite holdings.');
    b.note(110, 920, 420, 60,
      'Gems buy pulls; the box-open Delay + probabilistic Rarity Gate split each box ' +
      '70/22/7/1%. Surplus Commons salvage to Dust; gems also fund cosmetics.');
    b.note(1080, 920, 470, 60,
      'DAU is a birth-death process: installs pulse in (scaled by Level), churn ' +
      'drains a fraction each step. A % of DAU pays IAP, faucetting Gems.');
    this.renderer.render();
  }

  // 7 — CIVILIZATION EMPIRE: a 4X economy in one diagram. Food sets a carrying
  // capacity; Population grows logistically toward it (throttled by Happiness).
  // Production builds Granaries/Libraries/Markets/Theaters; accumulated Science
  // trips four tech activators in sequence (irrigation, drama, banking,
  // university), each compounding a yield. Theaters stay locked until Drama.
  _demoCiv() {
    const b = this._demo();
    // ───────────────────────── COLOURS & RESOURCE TYPES ─────────────────────────
    const C = { food:'#7cb342', prod:'#ff8a3d', gold:'#fdd835', sci:'#42a5f5', cult:'#ab47bc', pop:'#e0e0e0' };
    b.d.resourceTypes = [
      { name:'Food', color:C.food }, { name:'Production', color:C.prod },
      { name:'Gold', color:C.gold }, { name:'Science', color:C.sci },
      { name:'Culture', color:C.cult }, { name:'Citizens', color:C.pop },
    ];
    // Tunable empire constants (edit live in the Parameters panel).
    b.d.params = {
      growthK: 0.12,      // logistic birth coefficient
      famine: 0.18,       // starvation decay coefficient
      foodPerPop: 2,      // food each citizen eats / step
      techFarm: 110,      // Science to unlock Irrigation
      techDramaT: 320,    // Science to unlock Drama (enables Theaters)
      techBank: 1200,     // Science to unlock Banking
      techUni: 3500,      // Science to unlock University
      happyBase: 14,      // baseline happiness
    };

    // ───────────────────────── GROUPS ─────────────────────────
    b.group(120,  60, 760, 250, 'Population & Food',  '#7cb342');
    b.group(120, 340, 760, 360, 'Yields & Buildings', '#ff8a3d');
    b.group(920,  60, 540, 320, 'Tech Tree',          '#42a5f5');
    b.group(920, 410, 540, 300, 'Treasury & Culture', '#fdd835');

    // ───────────────────────── POPULATION (logistic) ─────────────────────────
    // Food surplus sets the carrying capacity the land can feed.
    const carry = b.node(NodeType.REGISTER, 470, 120, 'capacity',
      n => { n.formula = 'max(4, round(foodStock / foodPerPop) + 4)'; });
    // Logistic births — grow toward capacity, gated off when happiness <= 0.
    const births = b.node(NodeType.REGISTER, 660, 120, 'births',
      n => { n.formula = 'happy > 0 ? round(growthK * pop * (1 - pop/capacity)) : 0'; });
    // Famine deaths when the granary store is empty.
    const deaths = b.node(NodeType.REGISTER, 660, 215, 'deaths',
      n => { n.formula = 'foodStock <= 0 ? max(1, round(famine * pop)) : 0'; });

    const population = b.node(NodeType.POOL, 300, 170, 'Population',
      n => { n.setCount(6, C.pop); n.capacity = 400; });
    const foodStore = b.node(NodeType.POOL, 300, 250, 'Granary Store',
      n => { n.setCount(10, C.food); n.capacity = 300; });

    b.st(population, carry,  c => { c.variableName = 'pop'; });
    b.st(foodStore,  carry,  c => { c.variableName = 'foodStock'; });
    b.st(births, population, c => { c.modifier = true; c.modMode = 'rate'; c.modFactor =  1; c.label = 'Δ grow'; });
    b.st(deaths, population, c => { c.modifier = true; c.modMode = 'rate'; c.modFactor = -1; c.label = 'Δ famine'; });

    // ───────────────────────── FOOD ECONOMY ─────────────────────────
    const farmland = b.node(NodeType.SOURCE, 150, 200, 'Farmland', n => { n.resourceColor = C.food; });
    // Harvest scales with workers; Irrigation tech adds a big multiplier.
    const foodYield = b.node(NodeType.REGISTER, 150, 285, 'foodYield',
      n => { n.formula = 'round(pop * 1.4) + irrigation * round(pop * 0.8) + 4'; });
    b.res(farmland, foodStore, c => { c.rateMode = RateMode.FORMULA; c.formula = 'foodYield'; c.label = 'harvest'; });
    const eat = b.node(NodeType.DRAIN, 470, 250, 'Consumption');
    b.res(foodStore, eat, c => { c.rateMode = RateMode.FORMULA; c.formula = 'round(pop * foodPerPop)'; c.label = 'eat'; });

    // ───────────────────────── PRODUCTION (hammers) ─────────────────────────
    const workshop = b.node(NodeType.SOURCE, 150, 400, 'Workshops', n => { n.resourceColor = C.prod; });
    const prodYield = b.node(NodeType.REGISTER, 150, 485, 'prodYield', n => { n.formula = 'round(pop * 1.0) + 2'; });
    const hammers = b.node(NodeType.POOL, 320, 430, 'Production', n => { n.setCount(0, C.prod); n.capacity = 60; });
    b.res(workshop, hammers, c => { c.rateMode = RateMode.FORMULA; c.formula = 'prodYield'; c.label = 'hammers'; });

    // BUILDINGS — converters that turn Production into building levels. Each hammer
    // feed is GATED by a condition on its level variable so it stops pushing once
    // the line is maxed (no useless pile-up in the converter).
    const buildGranary = b.node(NodeType.CONVERTER, 500, 400, 'Build Granary', n => { n.inputAmount = 14; n.outputColor = C.food; });
    const granaryLvl   = b.node(NodeType.POOL,      660, 400, 'Granaries',     n => { n.setCount(0, C.food); n.capacity = 5; });
    b.res(hammers, buildGranary, c => { c.rate = 4; c.label = '4 hammers'; c.condEnabled = true; c.condRefMode = 'variable'; c.condVariable = 'granaries'; c.condOperator = '<'; c.condValue = 5; });
    b.res(buildGranary, granaryLvl, c => { c.rate = 1; });

    const buildLibrary = b.node(NodeType.CONVERTER, 500, 470, 'Build Library', n => { n.inputAmount = 18; n.outputColor = C.sci; });
    const libraryLvl   = b.node(NodeType.POOL,      660, 470, 'Libraries',     n => { n.setCount(0, C.sci); n.capacity = 5; });
    b.res(hammers, buildLibrary, c => { c.rate = 3; c.label = '3 hammers'; c.condEnabled = true; c.condRefMode = 'variable'; c.condVariable = 'libraries'; c.condOperator = '<'; c.condValue = 5; });
    b.res(buildLibrary, libraryLvl, c => { c.rate = 1; });

    const buildMarket = b.node(NodeType.CONVERTER, 500, 540, 'Build Market', n => { n.inputAmount = 16; n.outputColor = C.gold; });
    const marketLvl   = b.node(NodeType.POOL,      660, 540, 'Markets',      n => { n.setCount(0, C.gold); n.capacity = 5; });
    b.res(hammers, buildMarket, c => { c.rate = 3; c.label = '3 hammers'; c.condEnabled = true; c.condRefMode = 'variable'; c.condVariable = 'markets'; c.condOperator = '<'; c.condValue = 5; });
    b.res(buildMarket, marketLvl, c => { c.rate = 1; });

    // Theaters: gated TWICE — a level cap condition AND a Drama-tech activator.
    const buildTheater = b.node(NodeType.CONVERTER, 500, 610, 'Build Theater', n => { n.inputAmount = 20; n.outputColor = C.cult; });
    const theaterLvl   = b.node(NodeType.POOL,      660, 610, 'Theaters',      n => { n.setCount(0, C.cult); n.capacity = 5; });
    b.res(hammers, buildTheater, c => { c.rate = 2; c.label = '2 hammers'; c.condEnabled = true; c.condRefMode = 'variable'; c.condVariable = 'theaters'; c.condOperator = '<'; c.condValue = 5; });
    b.res(buildTheater, theaterLvl, c => { c.rate = 1; });

    // Publish building levels for the yield formulas.
    b.st(granaryLvl, foodYield, c => { c.variableName = 'granaries'; });
    b.st(libraryLvl, foodYield, c => { c.variableName = 'libraries'; });
    b.st(marketLvl,  foodYield, c => { c.variableName = 'markets'; });
    b.st(theaterLvl, foodYield, c => { c.variableName = 'theaters'; });

    // ───────────────────────── SCIENCE & TECH TREE ─────────────────────────
    const sciSource = b.node(NodeType.SOURCE, 980, 110, 'Scholars', n => { n.resourceColor = C.sci; });
    // Science output rises with population & libraries; University tech adds a big bonus.
    const sciRate = b.node(NodeType.REGISTER, 980, 195, 'science_rate',
      n => { n.formula = 'round(pop * 0.6) + libraries * 3 + university * round(pop*0.5) + 1'; });
    const research = b.node(NodeType.POOL, 1150, 150, 'Research', n => { n.setCount(0, C.sci); n.capacity = 100000; });
    b.res(sciSource, research, c => { c.rateMode = RateMode.FORMULA; c.formula = 'science_rate'; c.label = 'science'; });
    b.st(research, sciRate, c => { c.variableName = 'sciTotal'; });

    // Four techs flip from 0->1 as accumulated Research crosses each threshold.
    const techIrrigation = b.node(NodeType.REGISTER, 1320, 100, 'irrigation', n => { n.formula = 'sciTotal >= techFarm ? 1 : 0'; });
    const techDrama      = b.node(NodeType.REGISTER, 1320, 175, 'drama',      n => { n.formula = 'sciTotal >= techDramaT ? 1 : 0'; });
    const techBanking    = b.node(NodeType.REGISTER, 1320, 250, 'banking',    n => { n.formula = 'sciTotal >= techBank ? 1 : 0'; });
    const techUniversity = b.node(NodeType.REGISTER, 1320, 325, 'university', n => { n.formula = 'sciTotal >= techUni ? 1 : 0'; });

    // ───────────────────────── GOLD & TREASURY ─────────────────────────
    const mint = b.node(NodeType.SOURCE, 980, 460, 'Trade', n => { n.resourceColor = C.gold; });
    // Income from population & markets; Banking tech compounds market income.
    const goldRate = b.node(NodeType.REGISTER, 980, 545, 'goldRate',
      n => { n.formula = 'round(pop * 0.5) + markets * 4 + banking * markets * 3 + 2'; });
    const treasury = b.node(NodeType.POOL, 1150, 490, 'Treasury', n => { n.setCount(20, C.gold); n.capacity = 600; });
    b.res(mint, treasury, c => { c.rateMode = RateMode.FORMULA; c.formula = 'goldRate'; c.label = 'income'; });
    const upkeep = b.node(NodeType.DRAIN, 1320, 490, 'Upkeep');
    b.res(treasury, upkeep, c => { c.rateMode = RateMode.FORMULA; c.formula = 'round(pop * 0.3) + granaries + libraries + markets + theaters'; c.label = 'upkeep'; });
    b.st(treasury, goldRate, c => { c.variableName = 'gold'; });

    // ───────────────────────── CULTURE & HAPPINESS ─────────────────────────
    const cultSource = b.node(NodeType.SOURCE, 980, 620, 'Artisans', n => { n.resourceColor = C.cult; });
    const cultRate = b.node(NodeType.REGISTER, 980, 685, 'cultRate', n => { n.formula = 'theaters * 3 + round(pop*0.2) + 1'; });
    const culture = b.node(NodeType.POOL, 1150, 640, 'Culture', n => { n.setCount(0, C.cult); n.capacity = 100000; });
    b.res(cultSource, culture, c => { c.rateMode = RateMode.FORMULA; c.formula = 'cultRate'; c.label = 'culture'; });

    // Happiness: base + theaters + food surplus − crowding. Throttles births.
    const happiness = b.node(NodeType.REGISTER, 470, 215, 'happy',
      n => { n.formula = 'happyBase + theaters*3 + (foodStock > pop ? 4 : 0) - round(pop * 0.18)'; });

    // TECH ACTIVATOR: amphitheaters cannot be built until Drama is researched.
    b.st(techDrama, buildTheater, c => { c.activator = true; c.actOperator = '>='; c.actValue = 1; c.label = '⊢ drama'; });

    // ───────────────────────── CHARTS & NOTES ─────────────────────────
    b.chart(150, 470, 320, 200, 'Empire: Population · Food · Culture', [population.id, foodStore.id, culture.id]);
    b.chart(920, 730, 540, 175, 'Tech unlocks (0->1): Irrigation · Drama · Banking · University',
      [techIrrigation.id, techDrama.id, techBanking.id, techUniversity.id]);
    b.note(120, 720, 480, 120,
      'A turn-based empire as one living economy. Food sets the carrying capacity; ' +
      'Population grows LOGISTICALLY toward it and stalls when Happiness runs out. ' +
      'Production builds Granaries, Libraries, Markets and Theaters, each boosting a yield.');
    b.note(620, 720, 280, 120,
      'Research accumulates and trips four TECH ACTIVATORS in sequence. Irrigation ' +
      'lifts farms; Drama unlocks Theaters; Banking compounds gold; University ' +
      'multiplies science. Watch the S-curve and the tech steps in the charts.');
    this.renderer.render();
  }

  // 8 — MEGAFACTORY LINE: a 4-tier automated factory (raw extraction →
  // smelting → components → final assembly/shipping). Iron & copper mines are
  // finite; coal fuels smelters via an activator. A deliberate bottleneck (a
  // tiny Circuit buffer drained by a slow Assembly queue) pins at capacity and
  // backs the line up — gears & wire pile to their caps while widgets starve.
  _demoFactory() {
    const b = this._demo();
    // 4 tiers, left to right: raw extraction -> smelting -> components -> final
    // assembly/shipping. Iron & copper ore are FINITE (mines deplete). Coal fuels
    // the smelters through an activator. A deliberate BOTTLENECK (tiny Circuit
    // buffer drained by a slow Assembly queue) pins at capacity and backs the line
    // up: gears & wire pile up upstream while the widget line stays starved.
    const C = {
      ironOre:'#90a4ae', copperOre:'#bf6a3a', coal:'#37474f',
      ironPlate:'#cfd8dc', copperPlate:'#ff8a65',
      gear:'#8d6e63', wire:'#fdd835', circuit:'#66bb6a',
      steel:'#78909c', frame:'#5c6bc0', widget:'#42a5f5', scrap:'#ef5350',
    };
    b.d.resourceTypes = [
      { name:'Iron Ore', color:C.ironOre }, { name:'Copper Ore', color:C.copperOre },
      { name:'Coal', color:C.coal }, { name:'Iron Plate', color:C.ironPlate },
      { name:'Copper Plate', color:C.copperPlate }, { name:'Gear', color:C.gear },
      { name:'Wire', color:C.wire }, { name:'Circuit', color:C.circuit },
      { name:'Steel Beam', color:C.steel }, { name:'Frame', color:C.frame },
      { name:'Widget', color:C.widget }, { name:'Scrap', color:C.scrap },
    ];
    b.d.params = { ironYield:9, copperYield:4 };

    // ───── Tier bands ─────
    b.group(80, 60, 520, 740, 'Tier 0 · Raw Extraction', '#78909c');
    b.group(620, 60, 560, 740, 'Tier 1 · Smelting', '#ffa726');
    b.group(1200, 60, 540, 740, 'Tier 2 · Component Assembly', '#66bb6a');
    b.group(1760, 60, 900, 740, 'Tier 3 · Final Assembly & Shipping', '#42a5f5');

    // ===================== TIER 0 — RAW EXTRACTION =====================
    // Finite iron & copper mines + an infinite coal seam feeding ore buffers.
    const ironMine = b.node(NodeType.SOURCE, 150, 170, 'Iron Mine', n=>{ n.resourceColor=C.ironOre; n.limited=true; n.setCount(1400, C.ironOre); });
    const copperMine = b.node(NodeType.SOURCE, 150, 400, 'Copper Mine', n=>{ n.resourceColor=C.copperOre; n.limited=true; n.setCount(800, C.copperOre); });
    const coalSeam = b.node(NodeType.SOURCE, 150, 640, 'Coal Seam', n=>{ n.resourceColor=C.coal; });

    const ironOreBuf = b.node(NodeType.POOL, 380, 170, 'Iron Ore', n=>{ n.capacity=30; n.setCount(10, C.ironOre); });
    const copperOreBuf = b.node(NodeType.POOL, 380, 400, 'Copper Ore', n=>{ n.capacity=24; n.setCount(10, C.copperOre); });
    const coalBuf = b.node(NodeType.POOL, 380, 640, 'Coal Stock', n=>{ n.capacity=40; n.setCount(20, C.coal); });

    b.res(ironMine, ironOreBuf, c=>{ c.rateMode=RateMode.FORMULA; c.formula='ironYield'; c.label='extract'; });
    b.res(copperMine, copperOreBuf, c=>{ c.rateMode=RateMode.FORMULA; c.formula='copperYield'; c.label='extract'; });
    b.res(coalSeam, coalBuf, c=>{ c.rate=3; c.label='dig'; });

    // ===================== TIER 1 — SMELTING =====================
    // 2 ore -> 1 plate. Smelters fire only while the burner holds fuel (activator).
    // Belt DELAYS (conveyor transit) sit between smelter and plate buffer.
    const burner = b.node(NodeType.POOL, 700, 640, 'Burner Fuel', n=>{ n.capacity=14; n.setCount(6, C.coal); });
    b.res(coalBuf, burner, c=>{ c.rate=2; c.label='stoke'; });
    // Steady fuel burn each step (the furnaces consume coal as they run).
    b.st(burner, burner, c=>{ c.modifier=true; c.modMode='step'; c.modFactor=-1; c.label='burn'; });

    // Converters carry a small working buffer (capacity) so a blocked output
    // backs pressure UP the line instead of letting the machine hoard input.
    const ironSmelter = b.node(NodeType.CONVERTER, 720, 170, 'Iron Smelter', n=>{ n.inputAmount=2; n.outputColor=C.ironPlate; n.capacity=8; });
    const copperSmelter = b.node(NodeType.CONVERTER, 720, 400, 'Copper Smelter', n=>{ n.inputAmount=2; n.outputColor=C.copperPlate; n.capacity=8; });
    b.res(ironOreBuf, ironSmelter, c=>{ c.rate=8; c.label='2 ore'; });
    b.res(copperOreBuf, copperSmelter, c=>{ c.rate=3; c.label='2 ore'; });
    // Activator: a smelter only runs while fuel is present.
    b.st(burner, ironSmelter, c=>{ c.activator=true; c.actOperator='>'; c.actValue=0; c.label='fuel?'; });
    b.st(burner, copperSmelter, c=>{ c.activator=true; c.actOperator='>'; c.actValue=0; c.label='fuel?'; });

    // Belts are capacity-bounded too, so a full plate buffer backs pressure onto
    // the smelter rather than letting the belt hoard an unbounded backlog.
    const ironBelt = b.node(NodeType.DELAY, 920, 170, 'Iron Belt', n=>{ n.delay=3; n.capacity=12; });
    const copperBelt = b.node(NodeType.DELAY, 920, 400, 'Copper Belt', n=>{ n.delay=3; n.capacity=12; });
    b.res(ironSmelter, ironBelt, c=>{ c.rate=4; c.label='plate'; });
    b.res(copperSmelter, copperBelt, c=>{ c.rate=2; c.label='plate'; });

    const ironPlateBuf = b.node(NodeType.POOL, 1080, 170, 'Iron Plates', n=>{ n.capacity=28; });
    const copperPlateBuf = b.node(NodeType.POOL, 1080, 400, 'Copper Plates', n=>{ n.capacity=24; });
    b.res(ironBelt, ironPlateBuf, c=>{ c.rate=7; });
    b.res(copperBelt, copperPlateBuf, c=>{ c.rate=4; });

    // ===================== TIER 2 — COMPONENT ASSEMBLY =====================
    // Gears (2 iron plate -> 1 gear) and Wire (1 copper plate -> 1 wire).
    const gearPress = b.node(NodeType.CONVERTER, 1260, 170, 'Gear Press', n=>{ n.inputAmount=2; n.outputColor=C.gear; n.capacity=8; });
    const wireDrawer = b.node(NodeType.CONVERTER, 1260, 400, 'Wire Drawer', n=>{ n.inputAmount=1; n.outputColor=C.wire; n.capacity=8; });
    b.res(ironPlateBuf, gearPress, c=>{ c.rate=4; c.label='2 plate'; });
    b.res(copperPlateBuf, wireDrawer, c=>{ c.rate=3; c.label='plate'; });

    const gearBuf = b.node(NodeType.POOL, 1440, 170, 'Gears', n=>{ n.capacity=22; });
    const wireBuf = b.node(NodeType.POOL, 1440, 400, 'Wire', n=>{ n.capacity=22; });
    b.res(gearPress, gearBuf, c=>{ c.rate=2; });
    b.res(wireDrawer, wireBuf, c=>{ c.rate=3; });

    // Circuit Lab: a multi-ingredient recipe — gears + wire pushed into one
    // converter (inputAmount=3 held resources per circuit).
    const circuitLab = b.node(NodeType.CONVERTER, 1620, 290, 'Circuit Lab', n=>{ n.inputAmount=3; n.outputColor=C.circuit; n.capacity=9; });
    b.res(gearBuf, circuitLab, c=>{ c.rate=2; c.label='gear'; });
    b.res(wireBuf, circuitLab, c=>{ c.rate=3; c.label='wire'; });

    // ── Parallel STEEL sub-line (structural frames) ──
    // Iron plates also feed a steel furnace (2 plate -> 1 beam); beams weld into
    // frames. This contends with the gear press for the iron plate buffer — fair
    // allocation splits the plates between the two recipes.
    const steelFurnace = b.node(NodeType.CONVERTER, 1260, 620, 'Steel Furnace', n=>{ n.inputAmount=2; n.outputColor=C.steel; n.capacity=8; });
    b.res(ironPlateBuf, steelFurnace, c=>{ c.rate=3; c.label='2 plate'; });
    const steelBuf = b.node(NodeType.POOL, 1440, 620, 'Steel Beams', n=>{ n.capacity=18; });
    b.res(steelFurnace, steelBuf, c=>{ c.rate=2; });
    // Frame Welder is intentionally slow (draws beams at rate 1) so Steel Beams
    // backs up toward its cap — a second, milder back-pressure point.
    const frameWelder = b.node(NodeType.CONVERTER, 1620, 620, 'Frame Welder', n=>{ n.inputAmount=2; n.outputColor=C.frame; n.capacity=8; });
    b.res(steelBuf, frameWelder, c=>{ c.rate=1; c.label='beam'; });

    // Maintenance depot: gears are ALSO consumed (in a small share) to keep the
    // machines running — a competing draw on the gear buffer, drained on demand
    // (PULL, all-or-nothing every few steps).
    const maint = b.node(NodeType.POOL, 1620, 70, 'Spare Parts', n=>{ n.capacity=16; n.flowMode='pull'; n.pullPolicy='all'; });
    b.res(gearBuf, maint, c=>{ c.rate=1; c.interval=3; c.label='upkeep'; });
    const repairs = b.node(NodeType.DRAIN, 1760, 70, 'Repairs');
    b.res(maint, repairs, c=>{ c.rate=1; c.interval=4; c.label='use'; });

    // ===================== TIER 3 — FINAL ASSEMBLY & SHIPPING =====================
    // *** BOTTLENECK: a tiny Circuit buffer (cap 6) drained by a SLOW serial
    // Assembly queue (1 unit / 3 steps). The circuit buffer pins at 6 while the
    // Circuit Lab idles and gears/wire pile up upstream. ***
    const circuitBuf = b.node(NodeType.POOL, 1820, 290, 'Circuits', n=>{ n.capacity=6; n.setCount(0, C.circuit); });
    b.res(circuitLab, circuitBuf, c=>{ c.rate=2; c.label='circuit'; });

    // Capacity 4 on the queue means its intake stalls once it is holding 4
    // units — so the slow service rate (1 / 3 steps) propagates back and pins
    // the Circuits buffer at its cap of 6.
    const assemblyQ = b.node(NodeType.QUEUE, 1820, 480, 'Assembly Station', n=>{ n.processTime=3; n.capacity=4; });
    b.res(circuitBuf, assemblyQ, c=>{ c.rate=2; c.label='feed'; });

    // Packer: 1 assembled circuit -> 1 widget.
    const packer = b.node(NodeType.CONVERTER, 2000, 480, 'Widget Packer', n=>{ n.inputAmount=1; n.outputColor=C.widget; n.capacity=6; });
    b.res(assemblyQ, packer, c=>{ c.rate=1; });

    const widgetBuf = b.node(NodeType.POOL, 2000, 290, 'Widgets', n=>{ n.capacity=40; n.setCount(0, C.widget); });
    b.res(packer, widgetBuf, c=>{ c.rate=1; });

    // Frames buffer (output of the steel sub-line).
    const frameBuf = b.node(NodeType.POOL, 2000, 620, 'Frames', n=>{ n.capacity=24; });
    b.res(frameWelder, frameBuf, c=>{ c.rate=1; });

    // WAREHOUSE — a PULL pool that draws finished widgets + frames on demand
    // (flowMode=pull). It requests up to its incoming rates and takes what is
    // available, decoupling production from dispatch.
    const warehouse = b.node(NodeType.POOL, 2180, 460, 'Warehouse', n=>{ n.capacity=30; n.flowMode='pull'; n.pullPolicy='any'; });
    b.res(widgetBuf, warehouse, c=>{ c.rate=2; c.label='draw'; });
    b.res(frameBuf, warehouse, c=>{ c.rate=2; c.label='draw'; });

    // QC GATE splitter — probabilistic ~90% pass / ~10% scrap, fed from warehouse.
    const qcGate = b.node(NodeType.GATE, 2360, 170, 'QC Sorter', n=>{ n.gateMode='probabilistic'; });
    b.res(warehouse, qcGate, c=>{ c.rate=3; });
    const shipping = b.node(NodeType.DRAIN, 2520, 120, 'Shipping');
    const scrapBin = b.node(NodeType.DRAIN, 2520, 250, 'Scrap Bin');
    b.res(qcGate, shipping, c=>{ c.weight=9; c.label='pass'; });
    b.res(qcGate, scrapBin, c=>{ c.weight=1; c.label='scrap'; });

    // Registers: throughput (shipped tally) and a yield % efficiency metric.
    const throughput = b.node(NodeType.REGISTER, 2520, 380, 'throughput', n=>{ n.formula='shipped'; });
    b.st(shipping, throughput, c=>{ c.variableName='shipped'; c.label='shipped'; });
    b.st(scrapBin, throughput, c=>{ c.variableName='scrapped'; c.label='scrapped'; });
    const yieldPct = b.node(NodeType.REGISTER, 2520, 500, 'yieldPct', n=>{ n.formula='round(100 * shipped / max(1, shipped + scrapped))'; });
    // wipRegister — total work-in-progress held across the component buffers
    // (a one-step-lagged live readout of how clogged the mid-line is).
    const wip = b.node(NodeType.REGISTER, 2520, 620, 'wip', n=>{ n.formula='gearsHeld + wireHeld + circHeld'; });
    b.st(gearBuf, wip, c=>{ c.variableName='gearsHeld'; c.label='gears'; });
    b.st(wireBuf, wip, c=>{ c.variableName='wireHeld'; c.label='wire'; });
    b.st(circuitBuf, wip, c=>{ c.variableName='circHeld'; c.label='circ'; });

    // ───── Charts + notes ─────
    b.chart(120, 880, 640, 150, 'Back-pressure: Gears · Wire · Circuits(6) · Steel Beams', [gearBuf.id, wireBuf.id, circuitBuf.id, steelBuf.id]);
    b.chart(1640, 880, 640, 150, 'Output: Shipped · Scrap · Throughput · WIP', [shipping.id, scrapBin.id, throughput.id, wip.id]);
    b.note(800, 880, 400, 150,
      'BOTTLENECK: the Circuits buffer holds only 6 and is drained by the slow Assembly '+
      'Station (1 unit / 3 steps). Circuits pin at 6 while the Circuit Lab idles and '+
      'Gears / Wire swell to their caps. Classic back-pressure. The Steel Beams buffer '+
      'is a milder second one (the Frame Welder is slow). '+
      'FIX: raise the Circuits cap and/or lower the station processTime.');
    b.note(1230, 880, 380, 150,
      'Iron & Copper mines are FINITE; they deplete over a long run. Coal fuels the '+
      'smelters via an activator (no fuel -> no smelting). The Warehouse PULLS finished '+
      'widgets & frames on demand; Spare Parts is a competing pull on gears. The QC '+
      'Sorter is a probabilistic ~90/10 pass/scrap gate; yieldPct tracks the pass rate.');
    this.renderer.render();
  }

  // 9 — BUSINESS CYCLE: a full circular-flow macroeconomy. Household income
  // splits (gate) into consumption / saving / taxes; firms pay wages back —
  // a closed money loop the engine conserves. Banks lend (accelerator),
  // government spends, and a central bank injects countercyclical stimulus
  // through a 6-step policy lag. The lag makes output overshoot, an inflation
  // tax cools it, and "animal spirits" Poisson shocks sustain a boom-bust cycle.
  _demoBusinessCycle() {
    const b = this._demo();
    b.d.params = {
      mpc: 0.60, savRate: 0.22, taxRate: 0.18,   // marginal propensities (sum ~1)
      wageShare: 0.66,            // labour share of firm revenue
      loanRatio: 0.28,            // base fraction of deposits lent each step
      accel: 1.6,                 // accelerator: extra lending when output is below target
      gTarget: 175,               // central-bank output target (potential GDP)
      govProp: 0.55,              // fraction of the treasury spent each step
      cbGain: 3.0, cbCap: 120,    // monetary stimulus = gain*gap, hard-capped
      inflThresh: 1020, inflCap: 120, inflGain: 0.6,  // inflation tax (overheating leak)
      exportBase: 12, importProp: 0.06,               // foreign sector
    };
    b.d.resourceTypes = [
      { name: 'Cash', color: '#43a047' }, { name: 'Deposits', color: '#1e88e5' },
      { name: 'Credit', color: '#8e24aa' }, { name: 'Tax', color: '#fb8c00' },
      { name: 'Capital', color: '#26a69a' }, { name: 'Bonds', color: '#ec407a' },
    ];

    // ── Groups ──
    b.group(120, 110, 980, 600, 'Real Economy: Circular Flow', '#43a047');
    b.group(120, 760, 1360, 320, 'Banking & Credit', '#1e88e5');
    b.group(1140, 110, 800, 600, 'Government & Central Bank', '#fb8c00');
    b.group(1520, 760, 420, 320, 'Foreign Sector', '#26a69a');

    // ── Registers (dashboard row) ──
    const gdp        = b.node(NodeType.REGISTER, 300, 200, 'gdp',       n => { n.formula = 'cons + inv + gov + nx'; });
    const moneySupply= b.node(NodeType.REGISTER, 540, 200, 'money',     n => { n.formula = 'hh + fm + dep + tre + wf + ln + gm + iv + stm + go + res'; });
    const employment = b.node(NodeType.REGISTER, 780, 200, 'employ',    n => { n.formula = 'min(100, round(gdp / 2.2))'; });
    const confidence = b.node(NodeType.REGISTER, 1020, 200, 'confidence', n => { n.formula = 'max(0, min(100, 50 - gap * 0.25))'; });
    const gdpGap     = b.node(NodeType.REGISTER, 1240, 200, 'gap',      n => { n.formula = 'gTarget - gdp'; });
    const inflation  = b.node(NodeType.REGISTER, 1480, 200, 'inflation',n => { n.formula = 'max(0, (money - inflThresh) * inflGain)'; });
    const policyRate = b.node(NodeType.REGISTER, 1720, 200, 'rate',     n => { n.formula = 'max(0, 1 + inflation * 0.05 - gap * 0.02)'; });

    // ── HOUSEHOLDS / FIRMS (circular flow) ──
    const households = b.node(NodeType.POOL, 280, 380, 'Households',   n => { n.setCount(240, '#43a047'); n.capacity = 1e7; });
    const incomeSplit= b.node(NodeType.GATE, 520, 380, 'Income Split', n => { n.gateMode = 'deterministic'; });
    const goodsMkt   = b.node(NodeType.POOL, 760, 380, 'Goods Market', n => { n.setCount(0, '#43a047');   n.capacity = 1e7; });
    const production = b.node(NodeType.CONVERTER, 760, 560, 'Production', n => { n.inputAmount = 1; n.outputColor = '#43a047'; });
    const firms      = b.node(NodeType.POOL, 980, 380, 'Firms',        n => { n.setCount(160, '#43a047'); n.capacity = 1e7; });
    const wagePool   = b.node(NodeType.POOL, 520, 560, 'Wage Fund',    n => { n.setCount(0, '#43a047');   n.capacity = 1e7; });
    const capital    = b.node(NodeType.POOL, 980, 560, 'Capital Stock',n => { n.setCount(50, '#26a69a');  n.capacity = 1e7; });
    const cpiDrain   = b.node(NodeType.DRAIN, 280, 560, 'Inflation Tax');

    // ── BANKING ──
    const deposits   = b.node(NodeType.POOL, 280, 880, 'Deposits',       n => { n.setCount(90, '#1e88e5'); n.capacity = 1e7; });
    const reserves   = b.node(NodeType.POOL, 520, 880, 'Bank Reserves',  n => { n.setCount(30, '#1e88e5'); n.capacity = 1e7; });
    const loans      = b.node(NodeType.POOL, 760, 880, 'Loans',          n => { n.setCount(0, '#8e24aa');  n.capacity = 1e7; });
    const invLag     = b.node(NodeType.DELAY, 1000, 880, 'Investment Lag', n => { n.delay = 3; });
    const investment = b.node(NodeType.POOL, 1240, 880, 'Investment',    n => { n.setCount(0, '#8e24aa');  n.capacity = 1e7; });

    // ── GOVERNMENT / CENTRAL BANK ──
    const treasury   = b.node(NodeType.POOL, 1240, 380, 'Treasury',      n => { n.setCount(60, '#fb8c00'); n.capacity = 1e7; });
    const govSpend   = b.node(NodeType.POOL, 1480, 380, 'Govt Purchases',n => { n.setCount(0, '#fb8c00');  n.capacity = 1e7; });
    const bonds      = b.node(NodeType.POOL, 1720, 380, 'Bond Market',   n => { n.setCount(0, '#ec407a');  n.capacity = 1e7; });
    const centralBank= b.node(NodeType.SOURCE, 1240, 560, 'Central Bank',n => { n.resourceColor = '#43a047'; });
    const policyLag  = b.node(NodeType.DELAY, 1480, 560, 'Policy Lag',   n => { n.delay = 6; });
    const stimulus   = b.node(NodeType.POOL, 1720, 560, 'Stimulus',      n => { n.setCount(0, '#43a047');  n.capacity = 1e7; });

    // ── FOREIGN SECTOR ──
    const rowSrc     = b.node(NodeType.SOURCE, 1600, 840, 'Rest of World', n => { n.resourceColor = '#43a047'; });
    const exportsP   = b.node(NodeType.POOL, 1600, 980, 'Exports',  n => { n.setCount(0, '#43a047'); n.capacity = 1e7; });
    const importsD   = b.node(NodeType.DRAIN, 1820, 980, 'Imports');
    const nx         = b.node(NodeType.REGISTER, 1820, 840, 'nx', n => { n.formula = 'exportBase - round(importProp * hh)'; });
    const spirits    = b.node(NodeType.SOURCE, 1340, 720, 'Animal Spirits', n => { n.resourceColor = '#8e24aa'; });

    // ── CIRCULAR FLOW: income -> C/S/T; production -> revenue -> wages -> income ──
    b.res(households, incomeSplit, c => { c.rateMode = RateMode.FORMULA; c.formula = '(mpc + savRate + taxRate) * hh'; c.label = 'income'; });
    b.res(incomeSplit, goodsMkt,  c => { c.weight = 60; c.label = 'consume (C)'; });
    b.res(incomeSplit, deposits,  c => { c.weight = 22; c.label = 'save (S)'; });
    b.res(incomeSplit, treasury,  c => { c.weight = 18; c.label = 'tax (T)'; });
    b.res(goodsMkt, production,    c => { c.rate = 1e7; c.label = 'demand'; });
    b.res(production, firms,       c => { c.rate = 1;   c.label = 'output'; });   // 1:1 conversion (conserves money)
    b.res(firms, wagePool,        c => { c.rateMode = RateMode.FORMULA; c.formula = 'wageShare * fm'; c.label = 'wages'; });
    b.res(wagePool, households,    c => { c.rate = 1e7; c.label = 'pay'; });

    // ── BANKING: deposits -> loans (accelerator) -> investment lag -> firms; capital builds & depreciates ──
    b.res(deposits, reserves, c => { c.rateMode = RateMode.FORMULA; c.formula = '0.10 * dep'; c.label = 'reserve req'; });
    b.res(reserves, deposits, c => { c.rate = 4; c.label = 'reflow'; c.condEnabled = true; c.condRefMode = 'variable'; c.condVariable = 'gap'; c.condOperator = '<'; c.condValue = 0; });
    b.res(deposits, loans,    c => { c.rateMode = RateMode.FORMULA; c.formula = 'loanRatio * dep + accel * max(0, gap)'; c.label = 'lend'; });
    b.res(loans, invLag,      c => { c.rate = 1e7; c.label = 'fund'; });
    b.res(invLag, investment, c => { c.rate = 1e7; c.label = 'release'; });
    b.res(investment, firms,  c => { c.rateMode = RateMode.FORMULA; c.formula = '0.7 * iv'; c.label = 'invest (I)'; });
    b.res(investment, capital,c => { c.rate = 1e7; c.label = 'capex'; });
    b.st(deposits, deposits,  c => { c.modifier = true; c.modMode = 'rate'; c.modFactor = 0.02; c.label = 'interest'; });
    b.st(capital, capital,    c => { c.modifier = true; c.modMode = 'rate'; c.modFactor = -0.06; c.label = 'depreciation'; });

    // ── GOVERNMENT: spend purchases; deficit-finance via bonds when gap>0 ──
    b.res(treasury, govSpend, c => { c.rateMode = RateMode.FORMULA; c.formula = 'govProp * tre'; c.label = 'budget'; });
    b.res(govSpend, firms,    c => { c.rate = 1e7; c.label = 'spend (G)'; });
    b.res(reserves, bonds,    c => { c.rateMode = RateMode.FORMULA; c.formula = 'gap > 0 ? round(gap * 0.06) : 0'; c.label = 'bond sale'; });
    b.res(bonds, treasury,    c => { c.rate = 1e7; c.label = 'finance'; });

    // ── CENTRAL BANK: countercyclical money creation, capped, through a policy lag (overshoot -> cycle) ──
    b.res(centralBank, policyLag, c => { c.rateMode = RateMode.FORMULA; c.formula = 'min(cbCap, max(0, gap * cbGain))'; c.label = 'QE'; });
    b.res(policyLag, stimulus,    c => { c.rate = 1e7; c.label = 'arrive'; });
    b.res(stimulus, households,   c => { c.rate = 1e7; c.label = 'transfer'; });
    b.st(gdpGap, centralBank, c => { c.activator = true; c.actOperator = '>'; c.actValue = 0; });   // policy fires only while below target

    // ── ANIMAL SPIRITS: random (Poisson) investment-confidence bursts, likelier in slumps — sustains the cycle ──
    b.res(spirits, loans, c => { c.rateMode = RateMode.DISTRIBUTION; c.distType = 'poisson'; c.distParam1 = 6; c.label = 'optimism';
      c.chance = 35; c.condEnabled = true; c.condRefMode = 'variable'; c.condVariable = 'confidence'; c.condOperator = '<'; c.condValue = 45; });

    // ── INFLATION TAX: drains household cash when the money supply overheats ──
    b.res(households, cpiDrain, c => { c.rateMode = RateMode.FORMULA; c.formula = 'min(inflCap, inflation)'; c.label = 'erosion';
      c.condEnabled = true; c.condRefMode = 'variable'; c.condVariable = 'inflation'; c.condOperator = '>'; c.condValue = 0; });

    // ── FOREIGN SECTOR: exports add demand, imports leak ──
    b.res(rowSrc, exportsP, c => { c.rateMode = RateMode.FORMULA; c.formula = 'max(0, exportBase)'; c.label = 'X'; });
    b.res(exportsP, firms,  c => { c.rate = 1e7; c.label = 'sell abroad'; });
    b.res(households, importsD, c => { c.rateMode = RateMode.FORMULA; c.formula = 'round(importProp * hh)'; c.label = 'M'; });

    // ── STATE PUBLICATIONS (for registers / formula rates) ──
    b.st(households, gdp, c => { c.variableName = 'hh'; });
    b.st(firms, moneySupply, c => { c.variableName = 'fm'; });
    b.st(deposits, gdp, c => { c.variableName = 'dep'; });
    b.st(reserves, moneySupply, c => { c.variableName = 'res'; });
    b.st(treasury, gdp, c => { c.variableName = 'tre'; });
    b.st(wagePool, moneySupply, c => { c.variableName = 'wf'; });
    b.st(loans, moneySupply, c => { c.variableName = 'ln'; });
    b.st(goodsMkt, gdp, c => { c.variableName = 'cons'; });
    b.st(goodsMkt, moneySupply, c => { c.variableName = 'gm'; });
    b.st(investment, gdp, c => { c.variableName = 'inv'; });
    b.st(investment, moneySupply, c => { c.variableName = 'iv'; });
    b.st(govSpend, gdp, c => { c.variableName = 'gov'; });
    b.st(govSpend, moneySupply, c => { c.variableName = 'go'; });
    b.st(stimulus, moneySupply, c => { c.variableName = 'stm'; });
    b.st(nx, gdp, c => { c.variableName = 'nx'; });

    // ── CHARTS & NOTES ──
    b.chart(1140, 790, 360, 270, 'GDP · Money · Employment', [gdp.id, moneySupply.id, employment.id]);
    b.note(140, 130, 300, 150,
      'CIRCULAR FLOW. Household income splits at the gate into Consumption (C -> firms), ' +
      'Saving (S -> banks) and Taxes (T -> treasury). Firms pay Wages back to households, ' +
      'a closed loop that conserves money exactly.');
    b.note(1560, 130, 350, 150,
      'BUSINESS CYCLE. When GDP dips below target the Central Bank injects money (QE) ' +
      'through a 6-step Policy Lag, while banks lend more (accelerator). The lag makes ' +
      'output OVERSHOOT, then an inflation tax cools it, a self-sustaining cycle.');
    this.renderer.render();
  }

  // 10 — FOOD WEB: a four-trophic ecosystem in one diagram. Seasonal sunlight +
  // recycled nutrients feed two producers (logistic, nutrient-limited); three
  // grazers and a detritivore eat the base; two carnivores hunt them; Hawks are
  // the apex; a decomposer loop returns dead biomass to nutrients. Predation is
  // Lotka-Volterra formula rates; growth/death are register+modifier pairs. With
  // no goal set, all ten populations settle into coupled, bounded oscillations.
  _demoFoodWeb() {
    const b = this._demo();
    b.d.resourceTypes = [
      { name: 'Sunlight', color: '#ffd54f' },
      { name: 'Nutrients', color: '#8d6e63' },
      { name: 'Detritus', color: '#795548' },
      { name: 'Grass', color: '#66bb6a' },
      { name: 'Algae', color: '#26c6da' },
      { name: 'Rabbits', color: '#ffb74d' },
      { name: 'Insects', color: '#9ccc65' },
      { name: 'Zooplankton', color: '#4dd0e1' },
      { name: 'Worms', color: '#a1887f' },
      { name: 'Foxes', color: '#ef5350' },
      { name: 'Birds', color: '#5c6bc0' },
      { name: 'Hawks', color: '#ab47bc' },
    ];

    b.d.params = {
      // producer logistic growth
      grassGrow: 0.28, grassCap: 600,
      algaeGrow: 0.30, algaeCap: 500,
      // grazing coefficients (herbivore eats producer)
      grazeR: 0.0013, grazeI: 0.0013, grazeZ: 0.0018,
      // herbivore assimilation efficiency (grazed biomass -> births)
      effR: 0.50, effI: 0.60, effZ: 0.52,
      // herbivore baseline mortality
      dieR: 0.18, dieI: 0.15, dieZ: 0.20,
      // detritivore (worms eat detritus, eaten by birds)
      grazeW: 0.0015, effW: 0.50, dieW: 0.12,
      huntW: 0.0006,
      // predation (carnivore eats herbivore)
      huntF: 0.0042, huntB: 0.0018,
      effF: 0.58, effB: 0.46,
      dieF: 0.20, dieB: 0.22,
      // apex (hawk eats foxes + birds)
      apex: 0.006, effH: 0.42, dieH: 0.20,
      // seasonal forcing
      season: 0.30, period: 45, rainAmp: 0.25, rainPeriod: 30,
    };

    // ───── groups ─────
    b.group(60, 60, 540, 990, 'Abiotic: Nutrient Cycle & Light', '#26a69a');
    b.group(660, 60, 720, 400, 'Producers & Herbivores', '#7cb342');
    b.group(660, 480, 720, 400, 'Carnivores & Apex', '#ef5350');
    b.group(1440, 600, 360, 320, 'Ecosystem Diagnostics', '#78909c');

    // ───── abiotic layer ─────
    const sun = b.node(NodeType.SOURCE, 130, 150, 'Sunlight', n => { n.resourceColor = '#ffd54f'; });
    // step clock: a pool that gains exactly +1 per step (a 'step'-mode self-modifier),
    // published as `step`, so seasonal forcing reads a clean integer tick count.
    const clock = b.node(NodeType.POOL, 130, 470, 'Clock', n => { n.setCount(0, '#ffd54f'); });
    const season = b.node(NodeType.REGISTER, 350, 150, 'sunFactor',
      n => { n.formula = '1 + season * sin(2 * pi * step / period)'; });
    // a second, faster periodic forcing (rainfall) that modulates algae growth
    const rain = b.node(NodeType.REGISTER, 130, 620, 'rainFactor',
      n => { n.formula = '1 + rainAmp * sin(2 * pi * step / rainPeriod)'; });

    const nutrients = b.node(NodeType.POOL, 350, 320, 'Nutrients',
      n => { n.setCount(400, '#8d6e63'); n.capacity = 1500; });
    const detritus = b.node(NodeType.POOL, 350, 500, 'Detritus',
      n => { n.setCount(60, '#795548'); n.capacity = 1500; });
    const decomposer = b.node(NodeType.CONVERTER, 350, 700, 'Decomposers',
      n => { n.inputAmount = 2; n.outputColor = '#8d6e63'; });

    // detritivores: worms graze detritus and are preyed on by birds (links the
    // recycling loop to the living web — a "brown food chain").
    const worms = b.node(NodeType.POOL, 350, 900, 'Worms', n => { n.setCount(40, '#a1887f'); n.capacity = 400; });
    const wormReg = b.node(NodeType.REGISTER, 130, 900, 'wormBirths',
      n => { n.formula = 'round(effW * grazeW * detritus * worms)'; });

    // ───── producers ─────
    const grass = b.node(NodeType.POOL, 750, 160, 'Grass',
      n => { n.setCount(220, '#66bb6a'); n.capacity = 700; });
    const algae = b.node(NodeType.POOL, 750, 340, 'Algae',
      n => { n.setCount(180, '#26c6da'); n.capacity = 600; });
    // growth gated by both logistic self-limit AND nutrient availability (min term)
    const grassReg = b.node(NodeType.REGISTER, 950, 110, 'grassBirths',
      n => { n.formula = 'round(grassGrow * sunFactor * grass * (1 - grass/grassCap) * min(1, nutrients/200))'; });
    const algaeReg = b.node(NodeType.REGISTER, 950, 400, 'algaeBirths',
      n => { n.formula = 'round(algaeGrow * sunFactor * rainFactor * algae * (1 - algae/algaeCap) * min(1, nutrients/200))'; });

    // ───── herbivores ─────
    const rabbits = b.node(NodeType.POOL, 1140, 110, 'Rabbits', n => { n.setCount(50, '#ffb74d'); n.capacity = 400; });
    const insects = b.node(NodeType.POOL, 1140, 250, 'Insects', n => { n.setCount(60, '#9ccc65'); n.capacity = 500; });
    const zoopl = b.node(NodeType.POOL, 1140, 390, 'Zooplankton', n => { n.setCount(60, '#4dd0e1'); n.capacity = 500; });
    const rabReg = b.node(NodeType.REGISTER, 1320, 110, 'rabBirths',
      n => { n.formula = 'round(effR * grazeR * grass * rabbits)'; });
    const insReg = b.node(NodeType.REGISTER, 1320, 250, 'insBirths',
      n => { n.formula = 'round(effI * grazeI * grass * insects)'; });
    const zooReg = b.node(NodeType.REGISTER, 1320, 390, 'zooBirths',
      n => { n.formula = 'round(effZ * grazeZ * algae * zoopl)'; });

    // ───── carnivores ─────
    const foxes = b.node(NodeType.POOL, 750, 580, 'Foxes', n => { n.setCount(12, '#ef5350'); n.capacity = 200; });
    const birds = b.node(NodeType.POOL, 750, 740, 'Birds', n => { n.setCount(14, '#5c6bc0'); n.capacity = 250; });
    const foxReg = b.node(NodeType.REGISTER, 960, 580, 'foxBirths',
      n => { n.formula = 'round(effF * huntF * rabbits * foxes)'; });
    const birdReg = b.node(NodeType.REGISTER, 960, 740, 'birdBirths',
      n => { n.formula = 'round(effB * (huntB * (insects + zoopl) + huntW * worms) * birds)'; });

    // ───── apex ─────
    const hawk = b.node(NodeType.POOL, 1200, 700, 'Hawks', n => { n.setCount(3, '#ab47bc'); n.capacity = 80; });
    const hawkReg = b.node(NodeType.REGISTER, 1200, 560, 'hawkBirths',
      n => { n.formula = 'round(effH * apex * (foxes + birds) * hawks)'; });

    // weathering input passes through a Delay (slow mineral release from bedrock),
    // a maturation/lag pipeline before reaching the nutrient pool.
    const bedrock = b.node(NodeType.DELAY, 130, 320, 'Bedrock lag', n => { n.delay = 4; });

    // ───── ecosystem diagnostics (read-only registers) ─────
    const totReg = b.node(NodeType.REGISTER, 1520, 660, 'totalBiomass',
      n => { n.formula = 'grass + algae + rabbits + insects + zoopl + worms + foxes + birds + hawks'; });
    const prodReg = b.node(NodeType.REGISTER, 1520, 740, 'producerLoad',
      n => { n.formula = 'round(100 * (grass + algae) / (grassCap + algaeCap))'; });
    const predReg = b.node(NodeType.REGISTER, 1520, 820, 'predatorShare',
      n => { n.formula = 'round(100 * (foxes + birds + hawks) / max(1, grass + algae + rabbits + insects + zoopl + worms + foxes + birds + hawks))'; });

    // ───── step clock ─────
    b.st(clock, clock, c => { c.modifier = true; c.modMode = 'step'; c.modFactor = 1; c.label = 'tick'; });
    b.st(clock, season, c => { c.variableName = 'step'; });

    // ───── PUBLISH state variables (one-step lag) ─────
    b.st(grass, grassReg, c => { c.variableName = 'grass'; });
    b.st(algae, algaeReg, c => { c.variableName = 'algae'; });
    b.st(nutrients, grassReg, c => { c.variableName = 'nutrients'; });
    b.st(detritus, decomposer, c => { c.variableName = 'detritus'; });
    b.st(rabbits, rabReg, c => { c.variableName = 'rabbits'; });
    b.st(insects, insReg, c => { c.variableName = 'insects'; });
    b.st(zoopl, zooReg, c => { c.variableName = 'zoopl'; });
    b.st(foxes, foxReg, c => { c.variableName = 'foxes'; });
    b.st(birds, birdReg, c => { c.variableName = 'birds'; });
    b.st(hawk, hawkReg, c => { c.variableName = 'hawks'; });
    b.st(worms, wormReg, c => { c.variableName = 'worms'; });

    // ───── producer growth (register -> modifier) + nutrient uptake ─────
    b.st(grassReg, grass, c => { c.modifier = true; c.modMode = 'rate'; c.modFactor = 1; c.label = 'grow'; });
    b.st(algaeReg, algae, c => { c.modifier = true; c.modMode = 'rate'; c.modFactor = 1; c.label = 'grow'; });
    b.st(grassReg, nutrients, c => { c.modifier = true; c.modMode = 'rate'; c.modFactor = -0.35; c.label = 'uptake'; });
    b.st(algaeReg, nutrients, c => { c.modifier = true; c.modMode = 'rate'; c.modFactor = -0.35; c.label = 'uptake'; });

    // ───── grazing: biomass flows producer -> herbivore (formula predation) ─────
    b.res(grass, rabbits, c => { c.rateMode = RateMode.FORMULA; c.formula = 'grazeR * grass * rabbits'; c.label = 'graze'; });
    b.res(grass, insects, c => { c.rateMode = RateMode.FORMULA; c.formula = 'grazeI * grass * insects'; c.label = 'graze'; });
    b.res(algae, zoopl, c => { c.rateMode = RateMode.FORMULA; c.formula = 'grazeZ * algae * zoopl'; c.label = 'graze'; });

    // ───── herbivore births + mortality ─────
    b.st(rabReg, rabbits, c => { c.modifier = true; c.modMode = 'rate'; c.modFactor = 1; c.label = 'breed'; });
    b.st(insReg, insects, c => { c.modifier = true; c.modMode = 'rate'; c.modFactor = 1; c.label = 'breed'; });
    b.st(zooReg, zoopl, c => { c.modifier = true; c.modMode = 'rate'; c.modFactor = 1; c.label = 'breed'; });
    b.st(rabbits, rabbits, c => { c.modifier = true; c.modMode = 'rate'; c.modFactor = -0.18; c.label = 'die'; });
    b.st(insects, insects, c => { c.modifier = true; c.modMode = 'rate'; c.modFactor = -0.15; c.label = 'die'; });
    b.st(zoopl, zoopl, c => { c.modifier = true; c.modMode = 'rate'; c.modFactor = -0.20; c.label = 'die'; });

    // ───── detritivores: worms graze detritus, are eaten by birds ─────
    b.res(detritus, worms, c => { c.rateMode = RateMode.FORMULA; c.formula = 'grazeW * detritus * worms'; c.label = 'feed'; });
    b.st(wormReg, worms, c => { c.modifier = true; c.modMode = 'rate'; c.modFactor = 1; c.label = 'breed'; });
    b.st(worms, worms, c => { c.modifier = true; c.modMode = 'rate'; c.modFactor = -0.12; c.label = 'die'; });

    // ───── predation: herbivore -> carnivore ─────
    b.res(rabbits, foxes, c => { c.rateMode = RateMode.FORMULA; c.formula = 'huntF * rabbits * foxes'; c.label = 'hunt'; });
    b.res(insects, birds, c => { c.rateMode = RateMode.FORMULA; c.formula = 'huntB * insects * birds'; c.label = 'hunt'; });
    b.res(zoopl, birds, c => { c.rateMode = RateMode.FORMULA; c.formula = 'huntB * zoopl * birds'; c.label = 'hunt'; });
    b.res(worms, birds, c => { c.rateMode = RateMode.FORMULA; c.formula = 'huntW * worms * birds'; c.label = 'hunt'; });

    // ───── carnivore births + starvation ─────
    b.st(foxReg, foxes, c => { c.modifier = true; c.modMode = 'rate'; c.modFactor = 1; c.label = 'breed'; });
    b.st(birdReg, birds, c => { c.modifier = true; c.modMode = 'rate'; c.modFactor = 1; c.label = 'breed'; });
    b.st(foxes, foxes, c => { c.modifier = true; c.modMode = 'rate'; c.modFactor = -0.20; c.label = 'starve'; });
    b.st(birds, birds, c => { c.modifier = true; c.modMode = 'rate'; c.modFactor = -0.22; c.label = 'starve'; });

    // ───── apex predation: carnivore -> hawk ─────
    b.res(foxes, hawk, c => { c.rateMode = RateMode.FORMULA; c.formula = 'apex * foxes * hawks'; c.label = 'prey'; });
    b.res(birds, hawk, c => { c.rateMode = RateMode.FORMULA; c.formula = 'apex * birds * hawks'; c.label = 'prey'; });
    b.st(hawkReg, hawk, c => { c.modifier = true; c.modMode = 'rate'; c.modFactor = 1; c.label = 'breed'; });
    b.st(hawk, hawk, c => { c.modifier = true; c.modMode = 'rate'; c.modFactor = -0.20; c.label = 'starve'; });

    // ───── DEATH -> detritus (recycling loop) ─────
    b.res(grass, detritus, c => { c.rateMode = RateMode.FORMULA; c.formula = '0.06 * grass'; c.label = 'litter'; });
    b.res(algae, detritus, c => { c.rateMode = RateMode.FORMULA; c.formula = '0.06 * algae'; c.label = 'litter'; });
    b.res(rabbits, detritus, c => { c.rateMode = RateMode.FORMULA; c.formula = '0.08 * rabbits'; c.label = 'carcass'; });
    b.res(insects, detritus, c => { c.rateMode = RateMode.FORMULA; c.formula = '0.08 * insects'; c.label = 'carcass'; });
    b.res(zoopl, detritus, c => { c.rateMode = RateMode.FORMULA; c.formula = '0.08 * zoopl'; c.label = 'carcass'; });
    b.res(worms, detritus, c => { c.rateMode = RateMode.FORMULA; c.formula = '0.07 * worms'; c.label = 'carcass'; });
    b.res(foxes, detritus, c => { c.rateMode = RateMode.FORMULA; c.formula = '0.08 * foxes'; c.label = 'carcass'; });
    b.res(birds, detritus, c => { c.rateMode = RateMode.FORMULA; c.formula = '0.08 * birds'; c.label = 'carcass'; });
    b.res(hawk, detritus, c => { c.rateMode = RateMode.FORMULA; c.formula = '0.08 * hawks'; c.label = 'carcass'; });

    // detritus -> decomposer -> nutrients (close the loop). The Decomposer
    // consumes 2 detritus per conversion and mineralizes 1 nutrient — a ~50%
    // respiration loss, so the cycle is lossy and self-bounding. Weathering
    // (below) replaces the slow leak.
    b.res(detritus, decomposer, c => { c.rateMode = RateMode.FORMULA; c.formula = 'round(0.35 * detritus)'; c.label = 'decay'; });
    b.res(decomposer, nutrients, c => { c.rate = 1; c.label = 'mineralize'; });
    // sunlight drives a small seasonal weathering input that percolates through a
    // 4-step Bedrock lag (a Delay) before reaching the nutrient pool — replacing
    // the biomass slowly buried/lost from the lossy decomposition cycle.
    b.res(sun, bedrock, c => { c.rateMode = RateMode.FORMULA; c.formula = 'round(4 * sunFactor)'; c.label = 'weather'; });
    b.res(bedrock, nutrients, c => { c.rate = 999; c.label = 'release'; });

    // ───── charts ─────
    b.chart(1440, 80, 360, 230, 'Producers / Herbivores', [grass.id, algae.id, rabbits.id, insects.id, zoopl.id]);
    b.chart(1440, 340, 360, 230, 'Carnivores / Apex', [foxes.id, birds.id, hawk.id]);
    b.chart(660, 900, 720, 130, 'Nutrient Cycle', [nutrients.id, detritus.id, worms.id]);

    // ───── notes ─────
    b.note(660, 1060, 720, 130,
      'A four-trophic food web. Seasonal Sunlight + recycled Nutrients feed Grass & Algae ' +
      '(logistic, nutrient-limited). Three grazers eat the producers and Worms eat detritus; ' +
      'Foxes & Birds hunt them; Hawks are the apex. Dead biomass → Detritus → Decomposers ' +
      '→ Nutrients closes the loop (a respiration loss topped up by a Bedrock-lag weathering input).');
    b.note(60, 1060, 540, 130,
      'Predation uses Lotka-Volterra formula rates (coef·prey·pred); growth & death use ' +
      'register+modifier pairs. Two periodic drivers (sunFactor, rainFactor) force the ' +
      'producers. No goal is set, yet all ten populations lock into coupled, bounded ' +
      'oscillations, predator peaks lagging prey. Press Run.');
    this.renderer.render();
  }

  // 11 — AUCTION ECONOMY: a player-driven MMO virtual economy. Three gathering
  // chains refine raw goods (ore→bars, wood→planks, herb→potions) through
  // converters, a Forge delay and a Brew queue; a Toolsmith combines bars+planks
  // into tools. Sellers list goods at an auction house (Traders) and players buy
  // them back; scarcity drives price registers that set each trade's gold, and
  // price-elastic demand makes stocks and prices oscillate in a live market.
  _demoAuction() {
    const b = this._demo();
    // ── COLOURS / NAMED RESOURCE TYPES ─────────────────────────────────────────
    const ORE='#90a4ae', BAR='#ffa726', WOOD='#8d6e63', PLANK='#d7a86e',
          HERB='#66bb6a', POTION='#ab47bc', GOLD='#fdd835', TOOL='#26c6da';
    b.d.resourceTypes = [
      { name: 'Ore', color: ORE }, { name: 'Bar', color: BAR },
      { name: 'Wood', color: WOOD }, { name: 'Plank', color: PLANK },
      { name: 'Herb', color: HERB }, { name: 'Potion', color: POTION },
      { name: 'Tool', color: TOOL }, { name: 'Gold', color: GOLD },
    ];
    b.d.params = { baseBar: 5, basePlank: 4, basePotion: 8, baseTool: 10, gquest: 18 };

    // ── GROUPS ──────────────────────────────────────────────────────────────────
    b.group(70, 110, 760, 700, 'Gathering & Refining', '#8d6e63');
    b.group(870, 110, 560, 700, 'Auction House  (supply - price - gold)', '#f06292');
    b.group(1470, 110, 470, 700, 'Players & Treasury', '#fdd835');

    // ── GATHERING: SOURCE -> (yield GATE) -> RAW POOL -> REFINING CONVERTER ──────
    const oreMine = b.node(NodeType.SOURCE, 130, 200, 'Ore Mine', n => { n.resourceColor = ORE; });
    // Mining yield: a probabilistic gate routes most ore to the pool, the rest is
    // worthless slag (waste) — weighted routing that also adds noise to supply.
    const oreGate = b.node(NodeType.GATE, 220, 130, 'Ore Vein', n => { n.gateMode = 'probabilistic'; });
    const slag = b.node(NodeType.DRAIN, 130, 80, 'Slag');
    const orePool = b.node(NodeType.POOL, 360, 200, 'Ore', n => { n.capacity = 30; n.setCount(10, ORE); });
    const smelter = b.node(NodeType.CONVERTER, 520, 200, 'Smelter', n => { n.inputAmount = 2; n.outputColor = BAR; n.capacity = 8; });

    const forest = b.node(NodeType.SOURCE, 130, 360, 'Forest', n => { n.resourceColor = WOOD; });
    const woodPool = b.node(NodeType.POOL, 300, 360, 'Wood', n => { n.capacity = 30; n.setCount(10, WOOD); });
    const sawmill = b.node(NodeType.CONVERTER, 470, 360, 'Sawmill', n => { n.inputAmount = 2; n.outputColor = PLANK; n.capacity = 8; });

    const garden = b.node(NodeType.SOURCE, 130, 520, 'Herb Garden', n => { n.resourceColor = HERB; });
    const herbPool = b.node(NodeType.POOL, 300, 520, 'Herbs', n => { n.capacity = 30; n.setCount(12, HERB); });
    const alchemy = b.node(NodeType.CONVERTER, 470, 520, 'Alchemy Lab', n => { n.inputAmount = 3; n.outputColor = POTION; n.capacity = 6; });

    // gather rates: dice + Poisson for lively, slightly noisy raw supply
    b.res(oreMine, oreGate, c => { c.rateMode = RateMode.DICE; c.dice = '1d4'; c.label = '1d4'; });
    b.res(oreGate, orePool, c => { c.weight = 4; c.label = 'ore'; });   // ~80% usable ore
    b.res(oreGate, slag, c => { c.weight = 1; c.label = 'slag'; });     // ~20% waste
    b.res(forest, woodPool, c => { c.rateMode = RateMode.DICE; c.dice = '1d4'; c.label = '1d4'; });
    b.res(garden, herbPool, c => { c.rateMode = RateMode.DISTRIBUTION; c.distType = 'poisson'; c.distParam1 = 5; c.label = 'Poisson'; });

    // raw -> converter (PUSH). The feed is GATED on the finished-good stock: when
    // the market is glutted (stock above a ceiling) refining halts at the converter
    // input — just-in-time production that bounds every stock pool. (Conditions are
    // honoured on resource connections, but NOT on a delay/queue's own outputs, so
    // we throttle here, upstream of the Forge delay and Brew queue.)
    b.res(orePool, smelter, c => { c.rate = 2; c.label = 'feed'; c.condEnabled = true; c.condRefMode = 'variable'; c.condVariable = 'bar_stock'; c.condOperator = '<'; c.condValue = 22; });
    b.res(woodPool, sawmill, c => { c.rate = 2; c.label = 'feed'; c.condEnabled = true; c.condRefMode = 'variable'; c.condVariable = 'plank_stock'; c.condOperator = '<'; c.condValue = 22; });
    b.res(herbPool, alchemy, c => { c.rate = 3; c.label = 'feed'; c.condEnabled = true; c.condRefMode = 'variable'; c.condVariable = 'potion_stock'; c.condOperator = '<'; c.condValue = 18; });

    // ── CRAFTING LATENCY: a Forge delay and a Brew queue before stock ───────────
    const forge = b.node(NodeType.DELAY, 470, 680, 'Forge', n => { n.delay = 3; });
    // Brew queue is a single-server FIFO (1 potion / 2 steps). Cap it so excess
    // potions back up into the Alchemy Lab -> Herbs instead of growing forever.
    const brewQ = b.node(NodeType.QUEUE, 620, 520, 'Brew Queue', n => { n.processTime = 2; n.capacity = 6; });

    // ── CRAFTED-GOOD STOCK POOLS — auction supply; also hold sellers' gold ───────
    const barStock = b.node(NodeType.POOL, 900, 200, 'Bar Stock', n => { n.capacity = 400; n.setCount(14, BAR); });
    const plankStock = b.node(NodeType.POOL, 900, 360, 'Plank Stock', n => { n.capacity = 400; n.setCount(14, PLANK); });
    const potionStock = b.node(NodeType.POOL, 900, 520, 'Potion Stock', n => { n.capacity = 400; n.setCount(10, POTION); });

    // Smelter -> Forge(delay) -> Bar Stock. Rates match release so the delay only
    // adds latency (~3 units in flight) and never builds a runaway backlog.
    b.res(smelter, forge, c => { c.rate = 1; });
    b.res(forge, barStock, c => { c.rate = 2; });
    // Sawmill -> Plank Stock direct
    b.res(sawmill, plankStock, c => { c.rate = 1; });
    // Alchemy -> Brew Queue -> Potion Stock ; the single-server queue serialises
    // potion output to 1 per processTime and is capacity-capped so excess backs up.
    b.res(alchemy, brewQ, c => { c.rate = 1; });
    b.res(brewQ, potionStock, c => { c.rate = 1; });

    // ── TIER-2 CRAFT: Bars + Planks -> Tools (a Toolsmith converter) ────────────
    // The Toolsmith only buys raw goods when there's a SURPLUS (stock above a
    // floor), so it can't starve the auction supply — it competes for goods.
    const toolsmith = b.node(NodeType.CONVERTER, 470, 110, 'Toolsmith', n => { n.inputAmount = 2; n.outputColor = TOOL; n.capacity = 6; });
    const toolStock = b.node(NodeType.POOL, 900, 110, 'Tool Stock', n => { n.capacity = 200; n.setCount(8, TOOL); });
    b.res(barStock, toolsmith, c => { c.rate = 1; c.colorFilter = BAR; c.label = 'bar'; c.condEnabled = true; c.condRefMode = 'variable'; c.condVariable = 'bar_stock'; c.condOperator = '>'; c.condValue = 12; });
    b.res(plankStock, toolsmith, c => { c.rate = 1; c.colorFilter = PLANK; c.label = 'plank'; c.condEnabled = true; c.condRefMode = 'variable'; c.condVariable = 'plank_stock'; c.condOperator = '>'; c.condValue = 12; });
    b.res(toolsmith, toolStock, c => { c.rate = 1; c.condEnabled = true; c.condRefMode = 'variable'; c.condVariable = 'tool_stock'; c.condOperator = '<'; c.condValue = 22; });

    // ── PRICE REGISTERS: scarcity raises price (supply -> price feedback) ────────
    const barPrice = b.node(NodeType.REGISTER, 1110, 200, 'bar_price',
      n => { n.formula = 'round(baseBar * (1 + max(0, 30 - bar_stock)/12))'; });
    const plankPrice = b.node(NodeType.REGISTER, 1110, 360, 'plank_price',
      n => { n.formula = 'round(basePlank * (1 + max(0, 30 - plank_stock)/12))'; });
    const potionPrice = b.node(NodeType.REGISTER, 1110, 520, 'potion_price',
      n => { n.formula = 'round(basePotion * (1 + max(0, 24 - potion_stock)/10))'; });
    const toolPrice = b.node(NodeType.REGISTER, 1110, 110, 'tool_price',
      n => { n.formula = 'round(baseTool * (1 + max(0, 20 - tool_stock)/8))'; });

    // publish stock counts as variables (one-step lag) for the price registers
    b.st(barStock, barPrice, c => { c.variableName = 'bar_stock'; c.label = 'stock'; });
    b.st(plankStock, plankPrice, c => { c.variableName = 'plank_stock'; c.label = 'stock'; });
    b.st(potionStock, potionPrice, c => { c.variableName = 'potion_stock'; c.label = 'stock'; });
    b.st(toolStock, toolPrice, c => { c.variableName = 'tool_stock'; c.label = 'stock'; });

    // ── AUCTION HOUSE (SELL SIDE): stock pays goods, AH Vault pays gold back ──────
    // stock -> T -> ahGold : A=stock pays goods, B=ahGold pays gold back to stock.
    const ahGold = b.node(NodeType.POOL, 1300, 360, 'AH Vault', n => { n.capacity = 100000; n.setCount(1200, GOLD); });
    const barAuction = b.node(NodeType.TRADER, 1110, 290, 'Bar Sale');
    const plankAuction = b.node(NodeType.TRADER, 1110, 430, 'Plank Sale');
    const potionAuction = b.node(NodeType.TRADER, 1110, 600, 'Potion Sale');
    const toolAuction = b.node(NodeType.TRADER, 1110, 60, 'Tool Sale');

    // Sellers only LIST goods while stock is above a floor (they hold a reserve),
    // so a sell-off can't crash stock to zero — it relaxes, supply rebuilds.
    b.res(barStock, barAuction, c => { c.rate = 2; c.colorFilter = BAR; c.label = '2 bars'; c.condEnabled = true; c.condRefMode = 'variable'; c.condVariable = 'bar_stock'; c.condOperator = '>'; c.condValue = 6; });
    b.res(barAuction, ahGold, c => { c.rateMode = RateMode.FORMULA; c.formula = '2 * bar_price'; c.colorFilter = GOLD; c.label = 'gold'; });
    b.res(plankStock, plankAuction, c => { c.rate = 2; c.colorFilter = PLANK; c.label = '2 planks'; c.condEnabled = true; c.condRefMode = 'variable'; c.condVariable = 'plank_stock'; c.condOperator = '>'; c.condValue = 6; });
    b.res(plankAuction, ahGold, c => { c.rateMode = RateMode.FORMULA; c.formula = '2 * plank_price'; c.colorFilter = GOLD; c.label = 'gold'; });
    b.res(potionStock, potionAuction, c => { c.rate = 1; c.colorFilter = POTION; c.label = '1 potion'; c.condEnabled = true; c.condRefMode = 'variable'; c.condVariable = 'potion_stock'; c.condOperator = '>'; c.condValue = 4; });
    b.res(potionAuction, ahGold, c => { c.rateMode = RateMode.FORMULA; c.formula = 'potion_price'; c.colorFilter = GOLD; c.label = 'gold'; });
    b.res(toolStock, toolAuction, c => { c.rate = 1; c.colorFilter = TOOL; c.label = '1 tool'; c.condEnabled = true; c.condRefMode = 'variable'; c.condVariable = 'tool_stock'; c.condOperator = '>'; c.condValue = 4; });
    b.res(toolAuction, ahGold, c => { c.rateMode = RateMode.FORMULA; c.formula = 'tool_price'; c.colorFilter = GOLD; c.label = 'gold'; });

    // ── GUILD BANK: pulls sellers' earned gold OUT of stock pools (keeps room) ───
    const guildVault = b.node(NodeType.POOL, 680, 360, 'Guild Bank', n => { n.capacity = 100000; n.setCount(0, GOLD); n.flowMode = 'pull'; n.pullPolicy = 'any'; });
    b.res(barStock, guildVault, c => { c.rate = 999; c.colorFilter = GOLD; c.label = 'profit'; });
    b.res(plankStock, guildVault, c => { c.rate = 999; c.colorFilter = GOLD; c.label = 'profit'; });
    b.res(potionStock, guildVault, c => { c.rate = 999; c.colorFilter = GOLD; c.label = 'profit'; });
    b.res(toolStock, guildVault, c => { c.rate = 999; c.colorFilter = GOLD; c.label = 'profit'; });

    // ── PLAYERS (BUY SIDE): players pay gold to AH Vault, take goods home ─────────
    // ahGold -> T -> playerGold : AH pays goods, players pay gold back to AH Vault.
    // This RECYCLES gold into the AH Vault so the sell side never runs dry.
    const playerGold = b.node(NodeType.POOL, 1620, 200, 'Player Purse', n => { n.capacity = 100000; n.setCount(600, GOLD); });
    const buyBars = b.node(NodeType.TRADER, 1480, 290, 'Buy Bars');
    const buyTools = b.node(NodeType.TRADER, 1480, 110, 'Buy Tools');
    const buyPlanks = b.node(NodeType.TRADER, 1480, 430, 'Buy Planks');
    const buyPotions = b.node(NodeType.TRADER, 1480, 600, 'Buy Potions');
    // AH pays goods (filtered), players pay gold (price + AH markup) back to AH.
    // Buy-back gold per unit > sell payout per unit, so the AH Vault is never
    // drained (the house takes a small cut on every round trip). DEMAND IS PRICE-
    // ELASTIC: players only buy while the price sits below a threshold, so a
    // scarcity spike (high price) cools demand and lets stock recover — the swing
    // that makes prices and stocks oscillate instead of flat-lining.
    b.res(ahGold, buyBars, c => { c.rate = 2; c.colorFilter = BAR; c.label = '2 bars'; c.condEnabled = true; c.condRefMode = 'variable'; c.condVariable = 'bar_price'; c.condOperator = '<'; c.condValue = 13; });
    b.res(buyBars, playerGold, c => { c.rateMode = RateMode.FORMULA; c.formula = '2 * (bar_price + 3)'; c.colorFilter = GOLD; c.label = 'gold'; });
    b.res(ahGold, buyTools, c => { c.rate = 1; c.colorFilter = TOOL; c.label = '1 tool'; c.condEnabled = true; c.condRefMode = 'variable'; c.condVariable = 'tool_price'; c.condOperator = '<'; c.condValue = 16; });
    b.res(buyTools, playerGold, c => { c.rateMode = RateMode.FORMULA; c.formula = 'tool_price + 4'; c.colorFilter = GOLD; c.label = 'gold'; });
    b.res(ahGold, buyPlanks, c => { c.rate = 2; c.colorFilter = PLANK; c.label = '2 planks'; c.condEnabled = true; c.condRefMode = 'variable'; c.condVariable = 'plank_price'; c.condOperator = '<'; c.condValue = 11; });
    b.res(buyPlanks, playerGold, c => { c.rateMode = RateMode.FORMULA; c.formula = '2 * (plank_price + 2)'; c.colorFilter = GOLD; c.label = 'gold'; });
    b.res(ahGold, buyPotions, c => { c.rate = 1; c.colorFilter = POTION; c.label = '1 potion'; c.condEnabled = true; c.condRefMode = 'variable'; c.condVariable = 'potion_price'; c.condOperator = '<'; c.condValue = 20; });
    b.res(buyPotions, playerGold, c => { c.rateMode = RateMode.FORMULA; c.formula = 'potion_price + 3'; c.colorFilter = GOLD; c.label = 'gold'; });

    // Goods bought are consumed by the player base (a drain on the Player Purse's
    // goods so demand persists and the AH supply keeps cycling).
    const playerUse = b.node(NodeType.DRAIN, 1790, 290, 'Goods Used');
    b.res(playerGold, playerUse, c => { c.rate = 99; c.colorFilter = BAR; c.label = 'use'; });
    b.res(playerGold, playerUse, c => { c.rate = 99; c.colorFilter = PLANK; c.label = 'use'; });
    b.res(playerGold, playerUse, c => { c.rate = 99; c.colorFilter = TOOL; c.label = 'use'; });
    b.res(playerGold, playerUse, c => { c.rate = 99; c.colorFilter = POTION; c.label = 'use'; });

    // ── GOLD FAUCET (quests) -> Player Purse, and SINK (tax) on Guild Bank ───────
    const questBoard = b.node(NodeType.SOURCE, 1790, 200, 'Quest Board', n => { n.resourceColor = GOLD; });
    b.res(questBoard, playerGold, c => { c.rateMode = RateMode.FORMULA; c.formula = 'gquest'; c.colorFilter = GOLD; c.label = 'rewards'; });

    const taxSink = b.node(NodeType.DRAIN, 680, 540, 'Tax & Repairs');
    b.res(guildVault, taxSink, c => { c.rateMode = RateMode.FORMULA; c.formula = 'round(guild_gold * 0.04)'; c.colorFilter = GOLD; c.label = '4% tax'; });
    b.st(guildVault, taxSink, c => { c.variableName = 'guild_gold'; c.label = 'gold'; });

    // ── GOLD-DRIVEN PROSPECTING: a flush guild funds bonus ore (register+modifier)
    const prospect = b.node(NodeType.REGISTER, 300, 110, 'prospect',
      n => { n.formula = 'guild_gold > 300 ? 2 : 0'; });
    b.st(prospect, orePool, c => { c.modifier = true; c.modMode = 'rate'; c.modFactor = 1; c.label = 'bonus ore'; });

    // ── CHARTS + NOTES ──────────────────────────────────────────────────────────
    b.chart(870, 830, 560, 170, 'Stock Levels', [barStock.id, plankStock.id, potionStock.id, toolStock.id]);
    b.chart(1470, 830, 460, 170, 'Prices & Vault', [barPrice.id, potionPrice.id, toolPrice.id, ahGold.id]);

    b.note(70, 830, 760, 170,
      'A player-driven economy. Three gathering chains (ore->bars, wood->planks, ' +
      'herb->potions) refine through converters, with a Forge delay and a Brew queue ' +
      'for crafting latency; a Toolsmith combines bars+planks into Tools. Sellers list ' +
      'goods at the Auction House; players buy them back. Scarcity drives the price ' +
      'registers, which set how much gold each trade pays - a live supply/demand loop.');
    b.note(1470, 70, 470, 30,
      'Gold loops: quests -> players -> AH -> sellers -> guild -> tax sink.');
    this.renderer.render();
  }
}

for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(AppDemos.prototype))) {
  if (k !== 'constructor') Object.defineProperty(App.prototype, k, d);
}
