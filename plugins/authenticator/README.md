# Authenticator Plugin

Generate 2FA TOTP codes for configured services. Use when the user asks for a login code, 2FA code, or authenticator code for a service.

Available services are configured as TOTP_<SERVICE_NAME> environment variables. Call the list tool first to see which services are available, then generate the code for the requested one.

Codes refresh every 30 seconds — always generate a fresh one when asked.
