# The least worker time each graph of scripts/optimum.ts can hold, solved
# exactly with OR-Tools CP-SAT, beside what the planner held. Not run in
# CI: `pip install ortools` (the only solver that proves these in seconds).
#
#   python3 packages/vx-dte/scripts/optimum.py graphs.json [seconds a graph]
import json, sys
from ortools.sat.python import cp_model

graphs = json.load(open(sys.argv[1]))
limit = float(sys.argv[2]) if len(sys.argv) > 2 else 20
gaps = {}
for g in graphs:
    T, C, W = g['tasks'], g['cores'], int(g['warm'])
    n, H = len(T), int(g['chain'] + W)
    m = cp_model.CpModel()
    s = [m.NewIntVar(W, H - t['d'], f's{i}') for i, t in enumerate(T)]
    for i, t in enumerate(T):
        for d in t['deps']:
            m.Add(s[i] >= s[d] + T[d]['d'])
    # At most one worker a task; worker k spawns at a[k] and leaves at e[k].
    u = [m.NewBoolVar(f'u{k}') for k in range(n)]
    a = [m.NewIntVar(0, H, f'a{k}') for k in range(n)]
    e = [m.NewIntVar(0, H, f'e{k}') for k in range(n)]
    x = [[m.NewBoolVar(f'x{i}_{k}') for k in range(n)] for i in range(n)]
    for i in range(n):
        m.AddExactlyOne(x[i])
        # Symmetry: task i goes to a worker numbered no higher than i.
        for k in range(i + 1, n):
            m.Add(x[i][k] == 0)
    for k in range(n):
        ivs, dem = [], []
        for i, t in enumerate(T):
            m.AddImplication(x[i][k], u[k])
            m.Add(s[i] >= a[k] + W).OnlyEnforceIf(x[i][k])
            m.Add(s[i] + t['d'] <= e[k]).OnlyEnforceIf(x[i][k])
            ivs.append(m.NewOptionalFixedSizeIntervalVar(s[i], t['d'], x[i][k], f'iv{i}_{k}'))
            dem.append(t['c'])
        m.AddCumulative(ivs, dem, C)
        m.Add(e[k] >= a[k])
        m.Add(e[k] == 0).OnlyEnforceIf(u[k].Not())
        m.Add(a[k] == 0).OnlyEnforceIf(u[k].Not())
        if k + 1 < n:
            m.AddImplication(u[k + 1], u[k])
    m.Minimize(sum(C * (e[k] - a[k]) for k in range(n)))
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = limit
    solver.parameters.num_workers = 4
    status = solver.Solve(m)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        print(f"{g['name']:8} {g['seed']:2} no solution in {limit:.0f} s")
        continue
    best = solver.ObjectiveValue()
    gap = g['ours']['held'] / best - 1
    gaps.setdefault(g['name'], []).append(gap)
    proven = '*' if status == cp_model.OPTIMAL else ' '
    print(f"{g['name']:8} {g['seed']:2} held {g['ours']['held']:7.0f} end {g['ours']['end']:6.0f}/{H}"
          f"  optimum {best:7.0f}{proven}  gap {gap * 100:5.1f}%", flush=True)
for name, gs in gaps.items():
    print(f"{name:8} mean gap {sum(gs) / len(gs) * 100:5.1f}% over {len(gs)}")
