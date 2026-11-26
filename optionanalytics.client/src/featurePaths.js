// Pages shown only while the server has their feature on - the Tick Flow page with TrueData (TrueData:Enabled + its login -
// `trueData` in /api/auth/me, TrueDataOptions.TickFlowOn). Off, the menu has no entry and the route goes to the dashboard.
export const FEATURE_PATHS = { '/tick-flow': 'trueData' }
export const featureOn = (user, path) => !FEATURE_PATHS[path] || user?.[FEATURE_PATHS[path]] === true
