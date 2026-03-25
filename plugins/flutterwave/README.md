# Flutterwave Plugin

Manage Flutterwave dashboard operations — currently supports IP whitelisting.

## Authentication Flow
1. Login with email + password → get auth token
2. Verify with TOTP code (from authenticator plugin) → get session token
3. Perform actions with session token

## IP Whitelisting Flow
1. Login + 2FA (steps above)
2. Call whitelist_ip_init to add an IP — this triggers an email OTP to the user
3. User provides the email OTP
4. Call whitelist_ip_confirm with the email OTP to complete

IMPORTANT: The email OTP step requires the user to check their email. Ask them for the code, or use a Gmail plugin if available to retrieve it automatically.

Account ID: 24608
