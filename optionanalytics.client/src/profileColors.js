// One colour scheme for volume profiles everywhere (Order Flow footprint + profiles card, OI Replay):
// the PREVIOUS session's levels (carried into today) and TODAY's running (developing) profile are
// always told apart by colour. Each profile shows ONE POC, one value area (VAH / VAL), ONE HVN (its
// strongest high-volume node after the POC) and ONE LVN (its thinnest low-volume node).
export const PREV_PROFILE = { poc: '#fadb14', va: '#9b8cff', hvn: '#ffa940', lvn: '#69c0ff' }
export const RUNNING_PROFILE = { poc: '#ff4fd8', va: '#36cfc9', hvn: '#95de64', lvn: '#d3adf7', bar: '#36cfc9' }
