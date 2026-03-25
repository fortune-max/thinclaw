# Mercadona Plugin

Search for products on Mercadona (Spanish supermarket), get prices, and view product images (useful for checking ingredients).

Use this plugin when the user:
- Asks about product prices at Mercadona
- Wants to know ingredients of a Mercadona product
- Sends a photo of their shopping cart and wants a total price
- Searches for a specific product

IMPORTANT: The search index is in Spanish. Always translate product names to Spanish before searching (e.g., "bananas" → "plátanos", "bread" → "pan", "milk" → "leche"). The user may write in English — translate for the query, respond in whatever language they used.

Typical workflow for a cart photo: identify products from the image, search each one, get prices, sum them up.
For ingredients: search the product, get its ID, then fetch the product images (the zoom images show the ingredient label).
