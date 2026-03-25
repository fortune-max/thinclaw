# Gmail Plugin

Read emails from Gmail. Useful for:
- Fetching OTP codes sent via email (e.g., Flutterwave email verification)
- Checking recent emails
- Searching for specific emails

To get an OTP: search for recent emails from the relevant sender, read the message body, extract the code.

Chain with other plugins: e.g., Flutterwave triggers an email OTP → Gmail plugin fetches it → Flutterwave plugin uses it.
