using System.Runtime.CompilerServices;

// Lets the test project unit-test a handful of small, pure `internal` helpers directly (e.g.
// CdvUnderlyingState.ComputeLookbackChange) instead of standing up their entire owning class's
// live-state machinery (backfill, tick handling, hosted-service wiring) just to reach them.
[assembly: InternalsVisibleTo("OptionAnalytics.Server.Tests")]
