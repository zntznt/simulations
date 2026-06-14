// Knowledge base content for the in-app concept guide.
//
// Plain data, loaded as a browser global (no build step). Each entry is one
// concept explained in a single paragraph. Copy follows AP style: figures for
// 10 and above, no serial comma, "%" with a numeral, spelled-out fractions.
//
// Fields:
//   id        slug used for deep-linking (node-<type> / conn-<type> match the
//             properties-panel "?" so a selected element opens its own article)
//   category  grouping label; categories appear in first-seen order
//   title     display name
//   keywords  extra search terms (synonyms not already in title/body)
//   body      one-paragraph explanation, rendered as plain text
const KB_ARTICLES = [
  // ── Nodes ──────────────────────────────────────────────────────────────────
  {
    id: 'node-pool', category: 'Nodes', title: 'Pool',
    keywords: 'container store stock stockpile amount hold resources',
    body: 'A pool is a container that stores a quantity of a resource. It is the '
      + 'most common building block: resources flow in from sources or other '
      + 'nodes and pile up until something draws them out. When several outgoing '
      + 'connections compete for a limited stock, the pool shares what it has '
      + 'fairly rather than letting the first connection drain everything. Give a '
      + 'pool a capacity to cap how much it can hold, or set a starting amount so '
      + 'the model begins with resources already in place.',
  },
  {
    id: 'node-source', category: 'Nodes', title: 'Source',
    keywords: 'produce faucet generate spawn infinite unlimited limited stock',
    body: 'A source produces new resources and feeds them into the model — think '
      + 'of it as a faucet. By default a source is unlimited and never runs dry, '
      + 'emitting its rate every step for as long as the simulation runs. Switch '
      + 'on limited stock to give it a finite supply instead, and the source stops '
      + 'once that supply is spent. Each source emits resources in a single color, '
      + 'which downstream connections can filter on.',
  },
  {
    id: 'node-drain', category: 'Nodes', title: 'Drain',
    keywords: 'consume sink remove destroy spend loss decay output throughput',
    body: 'A drain consumes resources and removes them from the model permanently '
      + '— the opposite of a source. Resources that reach a drain are gone for '
      + 'good, so drains are how you model spending, decay, loss or any sink that '
      + 'should not feed back into the system. A drain records how much it has '
      + 'consumed, a figure you can chart or read through a state connection to '
      + 'track total output over a run.',
  },
  {
    id: 'node-gate', category: 'Nodes', title: 'Gate',
    keywords: 'split route distribute weight deterministic probabilistic random branch',
    body: 'A gate routes incoming resources to its outputs without storing '
      + 'anything itself. Each outgoing connection carries a weight, and the gate '
      + 'splits the flow according to those weights. In deterministic mode the '
      + 'split is proportional, so weights of three and one send three-quarters of '
      + 'the flow one way and one-quarter the other. In probabilistic mode the '
      + 'gate sends each unit to a single output chosen at random, with higher '
      + 'weights more likely to win; a weight of zero never receives anything.',
  },
  {
    id: 'node-converter', category: 'Nodes', title: 'Converter',
    keywords: 'convert craft refine recipe transform input output exchange',
    body: 'A converter turns one resource into another, consuming a set number of '
      + 'input resources to produce each unit of output. Set the input amount to '
      + 'define the recipe — an input amount of two means every two resources that '
      + 'arrive become one new resource in the converter’s output color. '
      + 'Converters are how you model crafting, refining or any exchange where raw '
      + 'materials are spent to make something else. Anything left over that '
      + 'cannot complete a full conversion stays put until enough arrives.',
  },
  {
    id: 'node-register', category: 'Nodes', title: 'Register',
    keywords: 'value formula compute derived variable score price calculation',
    body: 'A register holds a value calculated live from a formula rather than a '
      + 'stock of resources. Feed it the values it needs through state '
      + 'connections, give each one a variable name, then write a formula such as '
      + 'gold * 2 that the register recomputes every step. Registers are useful '
      + 'for derived numbers — a score, a price, a difficulty level — that depend '
      + 'on the rest of the model. Chained registers resolve in the same step, so '
      + 'a register can build on another register’s result without a lag.',
  },
  {
    id: 'node-delay', category: 'Nodes', title: 'Delay',
    keywords: 'wait hold time shift cooldown shipping latency buffer',
    body: 'A delay holds resources for a fixed number of steps and then releases '
      + 'them, preserving the amount but shifting it later in time. Set the delay '
      + 'length to control the wait: a delay of three releases each batch three '
      + 'steps after it arrives. Use a delay to model shipping time, cooldowns, '
      + 'construction or any process that takes a while to pay off. Resources in '
      + 'transit are kept separately for each batch, so amounts that arrive on '
      + 'different steps come out on schedule.',
  },
  {
    id: 'node-queue', category: 'Nodes', title: 'Queue',
    keywords: 'fifo line single server process time bottleneck wait contention',
    body: 'A queue serves one item at a time in the order it arrived, first in, '
      + 'first out. Its process time sets how long each item takes, which caps '
      + 'throughput: with a process time of three, the queue releases roughly one '
      + 'item every three steps no matter how fast items arrive. Anything waiting '
      + 'backs up behind the item in service, so a queue is the tool for modeling '
      + 'bottlenecks, single-server lines and contention for a scarce resource. It '
      + 'is the difference between a crowd and an orderly line.',
  },
  {
    id: 'node-trader', category: 'Nodes', title: 'Trader',
    keywords: 'trade exchange swap barter atomic partners deal market',
    body: 'A trader performs an atomic exchange between two partners, swapping '
      + 'resources only when both sides can pay in full. It pairs its incoming '
      + 'connections with its outgoing ones in order — the first in with the first '
      + 'out — and each pair trades only if both partners can afford their rate '
      + 'and have room to receive what they get. If either side falls short, '
      + 'nothing moves; there are no partial trades. The trader holds no resources '
      + 'of its own and simply counts the deals it closes.',
  },

  // ── Connections ──────────────────────────────────────────────────────────
  {
    id: 'conn-resource', category: 'Connections', title: 'Resource connection',
    keywords: 'flow pipe arrow rate move transfer solid',
    body: 'A resource connection moves actual resources from one node to another, '
      + 'drawn as a solid arrow. Its rate sets how much flows each time it fires — '
      + 'a fixed number, a dice roll, a formula or a random draw from a '
      + 'distribution. Resource connections are the pipes of the model: they carry '
      + 'the stuff that pools store, drains consume and converters transform. Most '
      + 'connections you draw will be resource connections.',
  },
  {
    id: 'conn-state', category: 'Connections', title: 'State connection',
    keywords: 'dashed signal information role trigger modifier activator condition label',
    body: 'A state connection carries information rather than resources, drawn as '
      + 'a dashed arrow. Instead of moving stuff, it reports a node’s value to '
      + 'somewhere else, where it can drive a register’s formula, modify a '
      + 'quantity, trigger a node, gate a flow with a condition or enable and '
      + 'disable a node as an activator. Pick the role in the connection’s '
      + 'properties. State connections are how the parts of a model sense and '
      + 'react to one another.',
  },
  {
    id: 'conn-colors', category: 'Connections', title: 'Resource colors and filters',
    keywords: 'color colour filter type kind route gold wood multiple resources',
    body: 'Every resource carries a color, which lets a single model move several '
      + 'distinct kinds of resource through the same network. A source emits one '
      + 'color, a converter stamps its output with another and pools keep a '
      + 'separate tally for each color they hold. Put a color filter on a '
      + 'connection to pass only matching resources and block the rest — the way '
      + 'to route gold one direction and wood another. Without a filter, a '
      + 'connection moves resources of any color.',
  },

  // ── Logic and control ──────────────────────────────────────────────────────
  {
    id: 'activation', category: 'Logic and control', title: 'Activation modes',
    keywords: 'automatic passive interactive starting fire when act trigger click',
    body: 'A node’s activation mode decides when it acts. Automatic nodes fire '
      + 'on their own every step and drive most models. Passive nodes never fire '
      + 'by themselves and wait to be set off by a trigger from elsewhere. '
      + 'Interactive nodes fire only when you click them during a run, which is '
      + 'how you build buttons and player choices. Starting nodes fire once at the '
      + 'beginning of the run and then go quiet, handy for one-time setup.',
  },
  {
    id: 'triggers', category: 'Logic and control', title: 'Triggers',
    keywords: 'trigger fire passive cascade every nth chance propagate activate',
    body: 'A trigger is a state connection that fires its target the moment its '
      + 'source fires, letting one event set off another. It is the way to drive '
      + 'passive nodes: when the source acts, the trigger passes the activation '
      + 'along. Tune it so it does not fire every time — set it to fire only every '
      + 'Nth activation, or give it a percentage chance so it fires at random. '
      + 'Triggers cascade safely, and the engine guards against loops so two nodes '
      + 'that trigger each other will not hang the simulation.',
  },
  {
    id: 'reverse-triggers', category: 'Logic and control', title: 'Reverse triggers',
    keywords: 'reverse fail failure empty shortage fallback alarm else',
    body: 'A reverse trigger is the mirror image of a trigger: it fires its target '
      + 'when the source fails to act rather than when it succeeds. A source fails '
      + 'when it cannot do its job — most often a pool that is empty or lacks the '
      + 'resources its outgoing connection needs. Use a reverse trigger to react '
      + 'to shortages, raise an alarm when a stock runs out or kick off a fallback '
      + 'when the usual path is blocked. It turns failure into a signal you can '
      + 'build on.',
  },
  {
    id: 'activators', category: 'Logic and control', title: 'Activators',
    keywords: 'activator enable disable gate threshold operator between unlock prerequisite',
    body: 'An activator is a state connection that switches its target node on or '
      + 'off based on a value. Compare the source’s value against a threshold '
      + 'with an operator such as greater than, at least or a between range, and '
      + 'the target is allowed to fire only while the test passes. Activators are '
      + 'the gatekeepers of a model: use one to keep a process idle until a '
      + 'resource builds up, to shut a feature off once a limit is reached or to '
      + 'model prerequisites and unlocks. When the test fails, the target simply '
      + 'does nothing that step.',
  },
  {
    id: 'conditions', category: 'Logic and control', title: 'Conditions, chance and intervals',
    keywords: 'condition chance probability interval gate fire compare threshold variable',
    body: 'A connection can gate its own firing in three ways. A condition '
      + 'compares a value — the source’s amount or a named variable — against '
      + 'a threshold and fires only when the test passes. A chance gives the '
      + 'connection a percentage probability of firing each time, for randomness. '
      + 'An interval fires the connection only every few steps rather than '
      + 'continuously. Combine them to express rules like a 50% chance to spend '
      + 'gold, but only while the player has more than 10.',
  },
  {
    id: 'capacity', category: 'Logic and control', title: 'Capacity',
    keywords: 'capacity limit cap ceiling full maximum storage overflow work-conserving',
    body: 'Capacity is the most a node can hold. Once a node reaches its capacity, '
      + 'it refuses further inflow, and the engine is work-conserving — resources '
      + 'that cannot fit are offered to other nodes or stay with their source '
      + 'rather than vanishing. Leave capacity unlimited for an open-ended '
      + 'stockpile, or set a ceiling to model storage limits, maximum health or '
      + 'any cap that should push back on the rest of the system. Capacity shapes '
      + 'contention, since a nearly full node leaves less room for everything '
      + 'competing to fill it.',
  },
  {
    id: 'flow-mode', category: 'Logic and control', title: 'Push and pull flow',
    keywords: 'push pull demand draw policy all any atomic flow mode direction',
    body: 'Flow direction decides who initiates a transfer. By default a model '
      + 'pushes: the upstream node fires and sends resources downstream. Switch a '
      + 'node to pull and it reaches upstream instead, drawing in what it needs '
      + 'each step. Pull comes with a policy: pull-all is atomic and moves nothing '
      + 'unless every provider can supply its full share, while pull-any takes '
      + 'whatever each provider has available. Pull is the right model for '
      + 'demand-driven systems, where consumers ask for resources rather than '
      + 'waiting to be fed.',
  },
  {
    id: 'end-conditions', category: 'Logic and control', title: 'End conditions',
    keywords: 'end goal win lose finish halt stop target operator victory',
    body: 'An end condition halts the whole simulation the moment a node’s '
      + 'value meets a target you set. Pick a node, choose an operator and a '
      + 'value, and the run stops as soon as the test passes — for instance, when '
      + 'a score reaches 100 or a health pool hits zero. End conditions define '
      + 'what winning, losing or finishing means for your model, and the status '
      + 'bar reports which node ended the run and on what step. In a Monte Carlo '
      + 'batch, the engine also tracks how often and how quickly the goal is '
      + 'reached.',
  },

  // ── Values and formulas ────────────────────────────────────────────────────
  {
    id: 'modifiers', category: 'Values and formulas', title: 'Modifiers',
    keywords: 'modifier rate step pulse delta self interest decay compounding factor',
    body: 'A modifier is a state connection that changes a target’s quantity '
      + 'directly instead of moving resources into it. The mode sets the rhythm: a '
      + 'rate modifier applies a percentage of the value each step, which is how '
      + 'you model interest or decay; a step modifier adds a flat amount every '
      + 'step; a pulse modifier adds an amount only when the source fires; and a '
      + 'delta modifier mirrors the source’s own change, scaled by a factor. '
      + 'Point a modifier from a node back to itself for compounding growth, and '
      + 'use a formula in place of a fixed amount when the change should depend on '
      + 'other values.',
  },
  {
    id: 'rate-modes', category: 'Values and formulas', title: 'Rate modes',
    keywords: 'rate fixed dice formula distribution normal uniform exponential poisson random seed',
    body: 'A connection’s rate mode sets how much it moves each time it '
      + 'fires. Fixed is a constant number. Dice rolls standard notation such as '
      + '2d6 for variable output with a predictable range. Formula computes the '
      + 'rate live from an expression, so flow can scale with the state of the '
      + 'model. Distribution draws a random amount from a normal, uniform, '
      + 'exponential or Poisson curve, for realistic noise. Every random mode uses '
      + 'the simulation’s seeded generator, so a seeded run repeats exactly.',
  },
  {
    id: 'formulas', category: 'Values and formulas', title: 'Formulas',
    keywords: 'formula expression math function round min max variable register rate',
    body: 'Formulas let you compute values from the rest of the model using '
      + 'ordinary math. Write expressions with the usual operators and functions — '
      + 'addition, multiplication, round, min, max and more — referring to any '
      + 'variable in scope by name. Registers use formulas to derive a value, '
      + 'connections use them to set a rate and modifiers use them to size a '
      + 'change. The editor lists the variables you can reference and flags an '
      + 'expression it cannot parse, so you can fix it before running. When the '
      + 'math library is available, formulas gain its full function set.',
  },
  {
    id: 'params', category: 'Values and formulas', title: 'Diagram parameters',
    keywords: 'parameter constant global tune balance dial setting variable',
    body: 'Parameters are named constants that belong to the whole model, set once '
      + 'in the simulation’s properties. Any formula can read a parameter by '
      + 'name, which makes them ideal for the numbers you want to tune in one '
      + 'place — a base income, a starting price, a difficulty multiplier. Change '
      + 'a parameter and every formula that uses it updates, so you can balance a '
      + 'design without hunting through individual nodes. Parameters are the dials '
      + 'of your model.',
  },
  {
    id: 'custom-vars', category: 'Values and formulas', title: 'Custom variables',
    keywords: 'custom variable list array lookup table sequence curve index values',
    body: 'Custom variables let you define your own named values, including lists '
      + 'of numbers, for formulas to draw on. They are handy for lookup tables and '
      + 'sequences — a curve of level-up costs, a schedule of payouts, a set of '
      + 'weights — that would be awkward to wire up as nodes. Reference a variable '
      + 'by name in any formula, and index into a list when you need a particular '
      + 'entry. The editor validates a variable’s definition and warns you '
      + 'when a list is malformed.',
  },

  // ── Running and analysis ───────────────────────────────────────────────────
  {
    id: 'running', category: 'Running and analysis', title: 'Running and stepping',
    keywords: 'run pause step reset speed tick play debug counter',
    body: 'Run advances the simulation continuously and animates resources as they '
      + 'move, while Step takes a single tick so you can inspect the model one '
      + 'beat at a time. Reset returns everything to its starting state. The speed '
      + 'control sets how fast a run plays, and the step counter shows how far it '
      + 'has gone. Stepping is the best way to debug a model, since you can watch '
      + 'exactly what each node does before the next tick.',
  },
  {
    id: 'interactive', category: 'Running and analysis', title: 'Interactive nodes',
    keywords: 'interactive click button player choice ability play prototype pulse',
    body: 'An interactive node fires only when you click it during a run, turning '
      + 'your model into something you can play. Set a node’s activation to '
      + 'interactive, press Run, then click the node to make it act on demand — '
      + 'the basis for buttons, abilities and player decisions. Pulse modifiers '
      + 'attached to an interactive node apply on each click, so a single press '
      + 'can add to a score or spend from a stockpile. It is how a diagram becomes '
      + 'a prototype you can actually try.',
  },
  {
    id: 'timeline', category: 'Running and analysis', title: 'Timeline chart',
    keywords: 'timeline chart graph plot history hover scrub series steps line',
    body: 'The timeline chart plots node values over the course of a run, so you '
      + 'can see how stocks rise, fall and settle rather than reading a single '
      + 'snapshot. Open it from the Analysis menu and it tracks the run live, '
      + 'updating as each step lands. Hover over the chart to read the exact value '
      + 'of every series at that step, and scrub back through the run to revisit '
      + 'an earlier moment without losing your place. It turns a simulation into a '
      + 'graph you can read at a glance.',
  },
  {
    id: 'monte-carlo', category: 'Running and analysis', title: 'Monte Carlo batch',
    keywords: 'monte carlo batch random runs mean min max histogram seed sweep statistics',
    body: 'A Monte Carlo batch runs your model many times and reports the spread '
      + 'of outcomes instead of a single result, which matters whenever chance is '
      + 'involved. Set the number of runs and the steps per run, and the batch '
      + 'reports the mean, minimum and maximum for each node along with a '
      + 'histogram of where results landed. When the model has an end condition, '
      + 'it also reports how often the goal was reached and how long it typically '
      + 'took. Seed the batch to make the whole experiment reproducible. The batch '
      + 'never disturbs your live diagram.',
  },
  {
    id: 'sensitivity', category: 'Running and analysis', title: 'Sensitivity analysis',
    keywords: 'sensitivity elasticity perturb parameter heatmap influence lever which matters tornado',
    body: 'A sensitivity analysis tells you which parameters matter most. It nudges '
      + 'every parameter up and down by a small percentage, one at a time, then '
      + 'measures how far each node’s average outcome moves in response. The result '
      + 'is a heatmap of elasticities — the percent change in a node per 1% change '
      + 'in a parameter — so a value near 1 means the two move together in lockstep, '
      + 'a larger value marks a powerful lever, and a value near zero means the '
      + 'parameter barely matters. Green marks a node that rises with the parameter '
      + 'and red one that falls; the brighter the cell, the stronger the link. Like '
      + 'the batch runs it works on copies, so your live diagram is never touched.',
  },
  {
    id: 'scenarios', category: 'Running and analysis', title: 'Scenario branching',
    keywords: 'scenario branch checkpoint fork ghost what-if capture restore compare',
    body: 'Scenario branching lets you capture the state of a run as a checkpoint '
      + 'and explore different futures from the same starting point. Save a '
      + 'checkpoint mid-run, then fork from it to try an alternative — a different '
      + 'choice, a tweaked parameter, a stroke of luck — without throwing away '
      + 'where you were. Earlier branches stay on the timeline as ghosts so you '
      + 'can compare paths side by side. It is the tool for asking what if without '
      + 'rebuilding the run by hand.',
  },
  {
    id: 'canvas-charts', category: 'Running and analysis', title: 'On-canvas charts',
    keywords: 'canvas chart widget live graph track node line bar area place',
    body: 'A canvas chart is a live graph you place directly on the diagram to '
      + 'watch a node as the model runs, keeping the data next to the system it '
      + 'describes. Drop a chart from the palette, point it at the nodes you want '
      + 'to track, then run the model to see the line, bars or area fill in. '
      + 'Charts are saved with your diagram, so the view you set up is there the '
      + 'next time you open it. Use them to keep an eye on the numbers that matter '
      + 'while you build.',
  },
  {
    id: 'editing', category: 'Building diagrams', title: 'Selecting and editing',
    keywords: 'select marquee multi-select copy paste duplicate delete right-click context menu rubber band move nudge',
    body: 'Click a node to select it, or drag an empty patch of canvas to rubber-band '
      + 'a group; hold Shift to add to a selection. With something selected you can '
      + 'copy and paste it with Ctrl+C and Ctrl+V, duplicate it in place with '
      + 'Ctrl+D, nudge it with the arrow keys, or remove it with Delete. '
      + 'Right-click anything to open a context menu with those same actions close '
      + 'to hand — duplicate, copy, save the selection as a reusable component, or '
      + 'delete — and right-click empty canvas to paste, select all or fit the view. '
      + 'Every edit is undoable with Ctrl+Z.',
  },
  {
    id: 'components', category: 'Building diagrams', title: 'Reusable components',
    keywords: 'component subgraph reuse stamp paste copy building block group selection save library',
    body: 'A component is a named building block you save from any selection of '
      + 'nodes and connections, then stamp onto the canvas as many times as you '
      + 'like. Select the nodes you want to reuse, open the Library, give the '
      + 'component a name and click Save component. Each time you click Insert, '
      + 'the app places a fresh independent copy — new node IDs, ready to edit — '
      + 'so modifying a placed copy never touches the saved original or any other '
      + 'instance. Components are a fast way to build repeated patterns such as a '
      + 'source–pool–drain trio, a feedback loop or a probability gate, without '
      + 'redrawing them every time.',
  },
  {
    id: 'connecting', category: 'Building diagrams', title: 'Connecting nodes',
    keywords: 'draw connect arrow link wire drag tool R T resource state connection endpoint',
    body: 'To draw a connection, select the resource connection tool by pressing R, '
      + 'then drag from one node to another. A green highlight appears when the '
      + 'cursor reaches a valid endpoint; releasing the mouse completes the arrow. '
      + 'For a state connection — the dashed kind that carries information rather '
      + 'than resources — press T first, then drag the same way. Once a connection '
      + 'exists, click it to select it and set its rate, mode and other properties '
      + 'in the panel on the right. Delete a connection by selecting it and pressing '
      + 'Delete, or right-click and choose Delete.',
  },
  {
    id: 'groups-notes', category: 'Building diagrams', title: 'Groups and notes',
    keywords: 'group container label boundary annotate note sticky comment region resize corner',
    body: 'A group is a labeled container you place over a region of the canvas to '
      + 'give a set of nodes a shared name and a visible border. Drag its corner '
      + 'handle to resize it; move it and the nodes inside travel with it. A note '
      + 'is a free-form text comment you can place anywhere on the canvas — useful '
      + 'for explaining what a part of the model does, narrating behavior or leaving '
      + 'a reminder. Both are added from the palette, saved with the diagram and can '
      + 'be selected and deleted like any other element.',
  },
  {
    id: 'navigation', category: 'Building diagrams', title: 'Navigation and zoom',
    keywords: 'pan zoom scroll wheel fit minimap overview touch pinch drag middle button navigate view',
    body: 'Scroll the mouse wheel to zoom in and out, or use the plus and minus '
      + 'buttons in the toolbar. Click the zoom level readout to reset to 100%, or '
      + 'press Ctrl+0 to fit the whole diagram in view. Pan by holding the middle '
      + 'mouse button and dragging, or hold Ctrl and drag with the left button. The '
      + 'minimap in the corner shows a scaled-down overview of the whole canvas — '
      + 'click or drag inside it to jump to any area. On a touchscreen, pinch with '
      + 'two fingers to zoom and drag with one to pan.',
  },
  {
    id: 'undo-redo', category: 'Building diagrams', title: 'Undo and redo',
    keywords: 'undo redo history ctrl+z ctrl+y stack revert mistake recover edit',
    body: 'Every structural edit — adding or moving a node, changing a property, '
      + 'loading a template — is recorded in a history stack. Press Ctrl+Z to undo '
      + 'the last change, and Ctrl+Shift+Z or Ctrl+Y to redo it. The stack holds '
      + '100 steps, enough for a long editing session. History is session-only and '
      + 'does not survive a page reload, though autosave preserves the latest '
      + 'diagram state. Because loading from the library is also undoable, you can '
      + 'always step back to what was there before.',
  },

  // ── Logic and control (additions) ─────────────────────────────────────────
  {
    id: 'time-modes', category: 'Logic and control', title: 'Time modes',
    keywords: 'time mode sync async synchronous asynchronous fire every phase offset rhythm rate turn-based',
    body: 'In the default sync mode, every automatic node fires together on each '
      + 'step — a turn-based rhythm where the whole model advances in lockstep. '
      + 'Switch the diagram to async mode and each automatic node runs on its own '
      + 'schedule instead, set by a fire-every count and an optional phase offset '
      + 'that staggers the start. Use async when parts of the system run at '
      + 'different rates — a quarterly income and a daily spending loop, for '
      + 'example. Passive, interactive and starting nodes are unaffected by the '
      + 'time mode; they still fire only when triggered or clicked.',
  },

  // ── Values and formulas (additions) ────────────────────────────────────────
  {
    id: 'resource-types', category: 'Values and formulas', title: 'Named resource types',
    keywords: 'resource type named label icon color colour holdings breakdown gold wood health per-type readout',
    body: 'Named resource types give the colors in your model a label and show '
      + 'per-type holdings in the properties panel, turning an abstract color into '
      + 'a meaningful category like gold, wood or health. Define types in the '
      + 'Resource Types section of the diagram settings rail; each type maps to one '
      + 'color and appears as a row in any node’s property panel, live-updating as '
      + 'the simulation runs. Types do not change how the engine moves or routes '
      + 'resources — that still works by color — but they make the diagram easier '
      + 'to read and give you a clear breakdown of what each pool holds.',
  },

  // ── Running and analysis (additions) ──────────────────────────────────────
  {
    id: 'sweep', category: 'Running and analysis', title: 'Parameter sweeps',
    keywords: 'sweep parameter range vary compare column table side-by-side balance tune inflection',
    body: 'A parameter sweep varies one diagram parameter across a range of values '
      + 'and runs a Monte Carlo batch for each value, then shows the results side '
      + 'by side so you can see the effect at a glance. Pick the parameter to vary, '
      + 'set how many steps to test across the range and define the low and high '
      + 'ends of the sweep. The output table shows per-node means for every value '
      + 'in one column each, making it straightforward to find the inflection point '
      + 'where the model tips from one behavior to another. Like all batch tools, '
      + 'the sweep runs on copies and never touches the live diagram.',
  },
  {
    id: 'scrubbing', category: 'Running and analysis', title: 'History scrubbing',
    keywords: 'scrub slider replay history past step rewind review non-destructive live playback',
    body: 'After a run, the scrub slider beneath the canvas lets you step back '
      + 'through the recorded history without rerunning the simulation. Drag the '
      + 'slider left and the canvas, charts and property readouts all update to '
      + 'show what the model looked like at that tick. Click Live to jump back to '
      + 'the end of the run. Scrubbing is read-only — it does not alter the '
      + 'simulation state, so you can review any past step and then press Run to '
      + 'continue forward from where the run finished.',
  },
  {
    id: 'artificial-player', category: 'Running and analysis', title: 'Artificial player',
    keywords: 'artificial player actor bot scripted auto-click rule interval condition stress test interactive',
    body: 'The artificial player is a scripted actor that fires interactive nodes '
      + 'automatically during a run, so you can stress-test a design without '
      + 'clicking by hand. Add rules in the artificial player panel — each rule '
      + 'picks an interactive node and sets when it fires: on a fixed interval or '
      + 'while a named variable meets a condition such as gold being greater than '
      + '100. Multiple rules run in order each step. It is how you simulate a '
      + 'player who always buys a power-up when resources are plentiful, or one who '
      + 'acts every five steps regardless of state.',
  },

  // ── Saving and sharing ─────────────────────────────────────────────────────
  {
    id: 'saving', category: 'Saving and sharing', title: 'Saving and loading',
    keywords: 'save load autosave library file JSON export import browser recovery banner',
    body: 'The diagram saves to the browser automatically on every change, so '
      + 'closing the tab does not lose your work. On your next visit, a banner '
      + 'offers to restore the last session if the canvas is empty. To keep '
      + 'multiple named diagrams, open the Library and click Save diagram — each '
      + 'entry is stored independently in the browser and can be loaded, renamed '
      + 'or deleted at any time. Use File → Save as JSON to download the current '
      + 'diagram as a portable file, and File → Load JSON to bring a saved file '
      + 'back onto the canvas.',
  },
  {
    id: 'sharing', category: 'Saving and sharing', title: 'Sharing and embedding',
    keywords: 'share URL link embed export SVG PNG publish present encode hash clipboard',
    body: 'Click Share in the File menu to encode the current diagram into the '
      + 'URL. The link contains the whole diagram, so anyone you send it to opens '
      + 'the same model in their browser — no sign-in or file transfer required. '
      + 'For a clean view without the editing chrome, add ?embed to the URL or '
      + 'append #embed to the hash; all the toolbars and panels hide, leaving only '
      + 'the canvas — useful for a presentation or a published page. SVG and PNG '
      + 'options in the File menu export a snapshot of the canvas for use outside '
      + 'the app.',
  },
];

// Expose for non-module browser scripts and the headless test harness.
if (typeof window !== 'undefined') window.KB_ARTICLES = KB_ARTICLES;
if (typeof module !== 'undefined' && module.exports) module.exports = { KB_ARTICLES };
