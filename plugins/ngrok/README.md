# Ngrok Plugin

Create public ngrok tunnels to expose local services via a public URL.

Use cases:
- Build a quick HTML page and share it with the user via a link
- Expose a local API for testing
- Serve files from the container publicly
- Show the user a dashboard, visualization, or any web content

Typical workflow:
1. Create an HTML file or start a simple HTTP server using bash (e.g., `npx serve /tmp/mysite -l 4000`)
2. Call ngrok_tunnel to expose the port
3. Share the public URL with the user
4. Call ngrok_close when done

Note: Tunnels persist until explicitly closed or the process restarts.
