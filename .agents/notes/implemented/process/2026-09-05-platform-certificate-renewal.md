# Agent Note: Platform certificate renewal through production OIDC

Status: implemented

English | [中文](2026-09-05-platform-certificate-renewal.zh.md)

## Problem

The operated ALB certificate was issued through a local ACME home and local Alibaba Cloud authorization. That state cannot provide unattended renewal: local OAuth expires, `/tmp` is not durable, and a workstation schedule depends on one Mac remaining online. Reissuing on every automation run would also consume certificate authority capacity and increase DNS and listener mutation risk.

## Decision

A daily GitHub Actions workflow checks the active production certificate and renews only inside its configured renewal window. It runs in Environment `production`, assumes the existing Alibaba Cloud deploy role through OIDC, and uses no Alibaba Cloud AccessKey or workstation state.

The workflow downloads one immutable acme.sh source archive and verifies its SHA-256 before execution. ACME account and domain state is archived under one exact key in the existing private deployment OSS bucket. The bucket applies OSS-managed AES256 server-side encryption, and each state upload explicitly requests it. Temporary state is owner-only and deleted when the job exits.

The ACME DNS hook calls AliDNS through the workflow's OIDC credentials instead of acme.sh's AccessKey integration. Every created challenge record id is retained in a private temporary file and deleted from a guaranteed cleanup path. Certificate activation requires a matching private key, the exact apex and www SAN set, and the configured minimum remaining lifetime. The workflow updates only the operated ALB listener, verifies both ALB addresses through normal TLS validation, and never deletes the previous certificate automatically.

Manual execution defaults to validation without issuance or listener mutation. Scheduled failures remain visible GitHub checks, and a failure inside the renewal window is the expiry alert.

## Alternatives considered

**Client-side envelope encryption or a dedicated KMS key.** Rejected because it adds a reusable decryption secret or a paid cloud service. Private OSS, AES256 server-side encryption, exact-object OIDC authorization, HTTPS, and owner-only runner files provide the selected lower-cost boundary.

**An Alibaba Cloud RAM user or acme.sh AliDNS plugin.** Rejected because both require a long-lived AccessKey. The stock AliDNS plugin persists that credential into the ACME account state.

**A workstation cron job.** Rejected because renewal would depend on Mac uptime and local OAuth state.

**Issue a certificate on every scheduled run.** Rejected because renewal must be driven by active-certificate lifetime and preserve certificate authority capacity.

## Consequences

Renewal depends on GitHub Actions and OSS control-plane confidentiality, while Alibaba Cloud authorization remains short-lived and federated. Server-side encryption protects storage media and provider backups, but an OSS compromise with object-read authority can expose ACME private state; exact-object IAM is therefore part of the security boundary. The previous CAS certificate remains available for explicit rollback and lifecycle cleanup is a separate reviewed operation.

## Verification

Platform workflow tests pin OIDC permissions, immutable ACME source verification, due and validation modes, OSS AES256 and owner-only state, challenge cleanup, key/SAN/lifetime validation order, listener-only mutation, and old-certificate retention. The operated dry-run validates current TLS and cloud read paths without certificate issuance.
