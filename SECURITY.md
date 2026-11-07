# Security Policy

## Legacy Android signing key

Releases through `3.22.1` were signed with a debug keystore that was committed
to the public repository. That certificate must be treated as compromised:

- Do not publish new builds with certificate
  `33C29CFDC5EB48421C8A27E235B304050EB3575A0A4522157B1B90314334A581`.
- Do not remove the old key without planning how Android users will migrate.
  Changing the signer prevents in-place upgrades for the existing package.
- Keep new release keys outside the repository. See
  `fe/work/docs/RELEASE-SIGNING.md`.
- Existing APKs are historical artifacts, not a safe release template.

## Reporting

Do not publish an exploitable issue with user data, signing material, or active
infrastructure credentials. Contact the repository owner privately, include the
affected version and reproduction steps, and allow time for a fix before public
disclosure.

## Local checks

Run these from `fe/work`:

```powershell
npm ci
npm run verify
npm run verify:release
```

CI fails if signing material is tracked. Local checks also reject known legacy
paths, version-source drift, and APKs signed with the exposed certificate.
