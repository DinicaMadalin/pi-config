/** The quality gate's check status, published on pi.events so other extensions (the dashboard) can show it. */
export const CHECK_STATUS_EVENT = "quality-gate:check-status";

export type CheckStatus =
	| { kind: "running"; checkName: string }
	| { kind: "passed"; checkNames: readonly string[] }
	| { kind: "failed"; checkName: string };
