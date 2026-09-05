# Agent Note: Platform certificate renewal through production OIDC

Status: implemented

English | [中文](2026-09-05-platform-certificate-renewal.zh.md)

## Problem

The operated ALB certificate was issued through a local ACME home and local Alibaba Cloud authorization. That state cannot provide unattended renewal: local OAuth expires, `/tmp` is not durable, and a workstation schedule depends on one Mac remaining online. Reissuing on every automation run would also consume certificate authority capacity and increase DNS and listener mutation risk.

## Decision

A daily GitHub Actions workflow checks the active production certificate and renews only inside its configured renewal window. An unprivileged job requires an explicit enable variable and a workflow commit contained by `master` before the Environment `production` OIDC job can start. The privileged job assumes the existing Alibaba Cloud deploy role and uses no Alibaba Cloud AccessKey or workstation state.

The workflow downloads one immutable acme.sh source archive and verifies its SHA-256 before execution. ACME account and domain state is archived under one exact key in the existing private deployment OSS bucket. The bucket applies OSS-managed AES256 server-side encryption, and each state upload explicitly requests it. Temporary state is owner-only and deleted when the job exits.

The ACME DNS hook calls AliDNS through the workflow's OIDC credentials instead of acme.sh's AccessKey integration and accepts only the two exact operated challenge names. A failed record deletion retains its id and fails the job. Certificate activation requires a matching private key, the exact apex and www SAN set, and the configured minimum remaining lifetime. Durable transaction metadata records the prior and candidate certificate ids and candidate fingerprint before the listener update. Both names on both ALB addresses must serve that fingerprint before commit; TLS or metadata-commit failure restores the prior binding while preserving renewed ACME state for retry. The workflow never deletes the previous certificate automatically.

Manual execution defaults to validation without issuance or listener mutation. Scheduled failures remain visible GitHub checks, and a failure inside the renewal window is the expiry alert.

## Alternatives considered

**Client-side envelope encryption or a dedicated KMS key.** Rejected because it adds a reusable decryption secret or a paid cloud service. Private OSS, AES256 server-side encryption, exact-object OIDC authorization, HTTPS, and owner-only runner files provide the selected lower-cost boundary.

**An Alibaba Cloud RAM user or acme.sh AliDNS plugin.** Rejected because both require a long-lived AccessKey. The stock AliDNS plugin persists that credential into the ACME account state.

**A workstation cron job.** Rejected because renewal would depend on Mac uptime and local OAuth state.

**Issue a certificate on every scheduled run.** Rejected because renewal must be driven by active-certificate lifetime and preserve certificate authority capacity.

## Consequences

Renewal depends on GitHub Actions and OSS control-plane confidentiality, while Alibaba Cloud authorization remains short-lived and federated. Server-side encryption protects storage media and provider backups, but an OSS compromise with object-read authority can expose ACME private state; exact-object IAM is therefore part of the security boundary. The workflow's master ancestry check prevents accidental branch activation, not a malicious workflow admitted by an unrestricted production Environment. Activation separately verifies Environment branch restrictions and OIDC trust. The previous CAS certificate remains available for explicit rollback and lifecycle cleanup is a separate reviewed operation.

## Verification

Executable shell tests pin the pre-OIDC enable gate, mutation-free validation, exact DNS-name rejection, OSS AES256 and owner-only state, and automatic prior-listener restoration after a failed durable commit. Static assertions retain immutable ACME source and credential-absence checks.
