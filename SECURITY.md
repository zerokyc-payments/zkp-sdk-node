# Security Policy

## Reporting a Vulnerability

Please **do not** report security vulnerabilities through public GitHub issues.

Report privately via GitHub's *Report a vulnerability* flow on this repository
(Report a vulnerability -> Security tab), or email **security@zerokyc-payments.com**.

Include a description, reproduction steps and affected versions. We aim to
respond within 72 hours and will credit reporters in release notes unless you
prefer to stay anonymous.

## Scope

- This SDK repository (client, webhook verification, examples).
- For platform/product vulnerabilities (API, checkout, console) use the same
  channel - we route internally.

## Out of scope

- Attacks requiring a compromised merchant API key or webhook secret.
- Rate limiting/resource exhaustion of our public endpoints without a proof
  of impact.

## Verification notes for auditors

- Webhook signature comparison uses `crypto.timingSafeEqual` for constant-time
  comparison (length-checked before the call).
- Timestamp tolerance defaults to +-300 seconds and is enforced before the
  HMAC comparison.
- Secrets are never included in exceptions or logs by the SDK itself.
- The SDK is server-side only; API keys and webhook secrets must never reach
  a browser bundle.
