// Shared design-system atoms used across the dashboard.
// Feature panels live in ../dashboard/, app providers in ../foundation/.
// Vendored change: ConfirmModal / Input / DismissibleHint were restored for
// the vendored SkillsPage (they were dropped in the original vendor closure
// because DashboardPage did not need them).

export { Button } from "./Button";
export { Card } from "./Card";
export { Shell } from "./Shell";
export { Badge } from "./Badge";
export { Select } from "./Select";
export { default as Counter } from "./Counter";
export { ConfirmModal } from "./ConfirmModal";
export { Input } from "./Input";
export { DismissibleHint } from "./DismissibleHint";
