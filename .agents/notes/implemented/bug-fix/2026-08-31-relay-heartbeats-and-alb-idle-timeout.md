# Agent Note: Keep the ALB Idle Timeout Above Relay Liveness

Status: implemented

English | [中文](2026-08-31-relay-heartbeats-and-alb-idle-timeout.zh.md)

## Problem

Desktop and Mobile Relay endpoints send authenticated heartbeats before the Platform heartbeat timeout. An ALB listener with a shorter idle timeout can close healthy WebSocket attachments before either endpoint sends its next heartbeat, forcing unnecessary reconnects and transient presence loss. This deployment mismatch is independent of concurrent pairing semantics and does not explain the shared-directory defect fixed by #371.

## Decision

Production deployment names the exact HTTPS listener through `PLATFORM_ALB_LISTENER_ID`. Deployment validation reads that listener through Alibaba Cloud OIDC and requires `IdleTimeout * 1000` to be at least `PLATFORM_RELAY_HEARTBEAT_TIMEOUT_MS` before a candidate can reach either ECS host.

The operated listener uses a 60-second idle timeout while Platform has a 45-second heartbeat timeout. Endpoint releases retain their 30-second authenticated heartbeat interval.

## Alternatives considered

**Release shorter Desktop and Mobile heartbeat intervals.** A shorter interval keeps the current listener active but requires coordinated client releases and increases steady network traffic. The listener must accommodate every client that already satisfies Platform's liveness requirement.

**Send server WebSocket ping frames.** Transport-level pings can keep intermediaries active, but they add another liveness mechanism beside authenticated endpoint heartbeats. The existing heartbeat timeout already defines the required intermediary lifetime.

**Keep the listener setting as an operator checklist.** A manual setting can drift without changing repository evidence. Deployment preflight now rejects the incompatible listener before production replacement begins.

## Consequences

Platform deployment requires read access to one configured ALB listener in addition to the existing ECS and server-group reads. A listener timeout below the authenticated Relay liveness window fails validation without changing ECS, server-group, DNS, certificate, or WAF state.

## Testing

The production-environment suite requires the listener id, validates its identifier, and inspects the workflow for the HTTPS protocol and heartbeat-timeout comparison. Issue [#499](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/499) owns this deployment correction. Issue [#368](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/368) retains the independent assembled two-Mobile presence evidence.
