# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 1.5.x   | Yes       |
| < 1.5   | No        |

## Reporting a Vulnerability

**Please do not open a public GitHub Issue for security vulnerabilities.**

If you discover a security issue in fusion-agent, report it privately:

1. **Email:** Open a [GitHub Security Advisory](https://github.com/your-org/fusion-agent/security/advisories/new) in the repository, or email the maintainers directly if that option is unavailable.
2. **Include:**
   - A description of the vulnerability and its potential impact.
   - Steps to reproduce (proof-of-concept if possible).
   - Any suggested mitigations or fixes.
3. You will receive an acknowledgement within **72 hours**.
4. We aim to release a fix within **14 days** of a confirmed report, depending on severity.

## Disclosure Policy

We follow [Coordinated Vulnerability Disclosure](https://en.wikipedia.org/wiki/Coordinated_vulnerability_disclosure). We ask that you:

- Give us reasonable time to address the issue before public disclosure.
- Avoid accessing or modifying data belonging to other users.

## Security Best Practices for Users

- **API Keys:** Store provider API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`) in environment variables or a secrets manager never commit them to source control.
- **Webhook secrets:** Always set a strong `WEBHOOK_SECRET` when exposing the web server to the internet.
- **Docker:** Run containers as a non-root user. The provided `Dockerfile` follows this practice.
- **Dependencies:** Keep dependencies up to date. Run `npm audit` regularly.

## Scope

The following are **in scope** for security reports:

- Remote code execution
- Authentication/authorisation bypasses in the web server
- Secrets leakage through logs or API responses
- Dependency vulnerabilities with a direct exploit path

The following are **out of scope**:

- Vulnerabilities in the AI provider APIs themselves (report those to the respective vendors)
- Issues only reproducible with full local access to the machine running the agent
