# Project Identity, Editing, and Routing

Project topology is part of the sound and must remain explicit.

- Address a track by the GUID/name pair observed in the current snapshot; revalidate immediately before mutation.
- Preserve each imported source as an independent track. Express grouping through folders, buses, and sends rather than destructive merging.
- Inspect main sends, sidechains, returns, and parallel paths before changing level or processing.
- Apply related changes inside one Undo boundary and return an execution receipt.
- Re-read topology after temporary measurement or probing and verify that it matches the pre-state.
- When a stale snapshot, duplicate FX instance, or ambiguous target is detected, stop the mutation and refresh project facts.

Routing edits have a wider blast radius than local parameter changes. State the intended downstream scope before modifying a bus, return, or master path.
