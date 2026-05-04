# CFR on Kuhn Poker — Live Visualization

A single-file, dependency-free animation that watches a poker bot learn from scratch using **Counterfactual Regret Minimization** (Zinkevich et al., NeurIPS 2007) on Kuhn poker.

## What it shows

- **Game tree walk** — the gold path lights up the action sequence the bot just traversed.
- **12 information sets** — live regrets, current strategy `σ`, and the running average that converges to Nash.
- **Live math walkthrough** — pick any info set and see the three CFR steps update each iteration: counterfactual EV → regret update → regret matching.
- **Strategy convergence chart** — average betting probabilities approach Nash-equilibrium targets (dashed lines).
- **Exploitability** — best-response gap vs. the current average strategy.

## Run

Open `index.html` in any modern browser. No build step, no dependencies.

```bash
open index.html
```

Use **Play / Step / Reset** and the speed selector to control training. Click any information-set card to inspect its math.

## Files

- `index.html` — the visualization (vanilla JS + Canvas + SVG).
- `glossary.html` — terms you need to follow CFR (information set, regret, counterfactual value, Nash equilibrium, etc.).

## Algorithm

Vanilla CFR over all 6 card permutations per iteration:

```
regret(I, a) += π_{-i}(I) · ( v(I,a) − v(I) )
σ(I, a)      = max(0, R(I,a)) / Σ max(0, R(I,·))
```

The *average* strategy across iterations is the one that converges to a Nash equilibrium — the bot becomes unexploitable without ever modeling its opponent.

## Reference

Zinkevich, Bowling, Johanson, Piccione. *Regret Minimization in Games with Incomplete Information.* NeurIPS 2007.
