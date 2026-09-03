# Agent Note: Replaceable phone runtime generations

Status: implemented

English | [中文](2026-08-31-phone-runtime-replaceable-generation.zh.md)

## Problem

Managed mobilecli preparation completes after Desktop composition, while `PhoneDevices` originally resolved one executable and owned one child for its entire Service lifetime. Mounting phone-runtime, phone-stream, and tool-phone only after preparation required a Desktop restart; leaving their tools registered before a child was ready advertised operations that could not execute.

## Decision

`PhoneDevices` keeps one Cordis Service identity and owns replaceable mobilecli generations. `activateExecutable(path)` aborts prior generation IO, drains startup and polling, stops the child process, publishes an empty listing with exact removals, and starts readiness probing for the replacement. `deactivate()` performs the same stop without destroying the Service. `isReady()` and `onReadinessChanged()` expose the committed generation state.

`tool-phone` registers all six deferred definitions only while the fleet is ready and disposes all six on the not-ready transition. Implementations that predate the readiness interface keep static registration so the Service Definition remains usable outside the managed Desktop composition.

Generation removal is an ordinary listing publication rather than a silent cache reset. The package invariant therefore observes one continuous listing history across replacements, and GUI/stream consumers cannot retain a device from a stopped child as current.

## Alternatives considered

**Restart Desktop after preparation.** Rejected because settings preparation is a live product operation and the Host owns enough lifecycle state to replace only the mobilecli child.

**Replace the `phoneDevices` Service instance.** Rejected because phone-stream, tool-phone, and subscribers bind the Service through Cordis effects; replacing its identity would spread remount coordination across every Consumer.

**Keep tools registered and fail each execution until ready.** Rejected because tool discovery would advertise unavailable capabilities and durable loaded-tool reconstruction would retain them after a generation stops.

## Consequences

Preparation, version replacement, disable, and teardown share one child-stop path that reaches process quiescence. Runtime readiness becomes the single registration condition for model-facing phone tools. Android/iOS platform preparation remains outside this decision and can activate the same stable fleet after it supplies prerequisites.
