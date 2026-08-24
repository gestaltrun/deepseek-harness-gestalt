# Agent Note: Platform Public Readiness Before Cutover

Status: implemented

English | [中文](2026-08-24-platform-public-readiness.zh.md)

## Problem

The Platform deployment checked each candidate and replacement only through an ECS loopback route. A workflow could therefore report success while production DNS, TLS, the ALB listener, or its backend group made the product origin unreachable.

## Decision

After both rolling replacements pass loopback readiness, the workflow requests the production HTTPS `/readyz` route from the GitHub runner and verifies the selected attachment storage and both expected non-sensitive instance ids. This check runs while the error trap and stopped predecessor containers still exist. Exhausting the bounded retry triggers the existing all-host rollback.

## Alternatives considered

**Check the public route after deleting rollback containers.** Rejected because external routing failure would be discovered after the recoverable replacement window.

**Treat ECS loopback readiness as deployment success.** Rejected because Mobile, Desktop, OAuth, and Relay clients use the public origin rather than host loopback.

**Check only the ALB TCP port.** Rejected because an open listener does not prove certificate, HTTP routing, backend health, or the active attachment-storage phase.

## Consequences

An unreachable, sticky, partially registered, or incorrectly routed product origin now fails the deployment before its predecessors are removed. The deployment remains bounded and does not modify ALB or DNS configuration automatically.

## Testing

The workflow contract test requires the public readiness check, the production origin, both expected instances, and execution before rollback cleanup. Executable shell tests make the public route fail, return the wrong storage, or expose only one backend and verify that both predecessor hosts are restored; the success case observes both instances and reaches cleanup without rollback. The operated deployment supplies the runtime proof against the real HTTPS origin.
