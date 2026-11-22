# TODOS

## web-control

### Daylight light theme
- **What:** A high-contrast light theme toggle for the Boat Link dashboard.
- **Why:** The laptop may sit on a dock in direct sunlight, where a dark UI is hard to read.
- **Pros:** Usable outdoors without squinting.
- **Cons:** A second palette to keep in sync with the dark tokens.
- **Context:** Design review on 2026-11-21 chose dark-only for the first build (decision 14A in `.context/dashboard-redesign-plan.md`). Tokens live in `web-control/app/globals.css`.
- **Depends on:** the dark token set landing first.

### DESIGN.md for web-control
- **What:** Write the dashboard tokens (surfaces, semantic colours, series colours, radii, type) and component rules into a `DESIGN.md`.
- **Why:** Future pages (parameters, mission view) should reuse the same vocabulary instead of re-deciding it.
- **Pros:** Consistency; design reviews can calibrate against it.
- **Cons:** Another file to keep current.
- **Context:** Review decisions 8A and 9A in `.context/dashboard-redesign-plan.md` are the source.
- **Depends on:** nothing.
