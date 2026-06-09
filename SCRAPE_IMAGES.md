# Scrape Image URLs and Clone Locally

A quick method for grabbing all gallery image URLs from a page and downloading them.

## 1. Copy the URLs from the page

Open the target page in Chrome, open DevTools (`Cmd+Option+I`) → **Console**, and paste:

```javascript
copy([...new Set([...document.querySelectorAll('a[href]')]
  .map(a => a.href)
  .filter(h => h.startsWith("https://bendsteelsupply.com/wp-content/uploads/photo-gallery/"))
  .map(h => h.split('?')[0]))].join('\n'));
console.log('Trimmed URL list copied to clipboard');
```

Change the URL in `.startsWith(...)` to match the site you're scraping. The
`.split('?')[0]` strips any `?query` so files save with clean names.

## 2. Save to a client file

Paste the clipboard contents into a `urls.txt` file in the client's directory:

```
Cinder Labs/Clients/<client-slug>/urls.txt
```

## 3. Download all images

```bash
cd "Cinder Labs/Clients/<client-slug>"
wget -i urls.txt
```

> `wget` not installed? `brew install wget` (macOS).
