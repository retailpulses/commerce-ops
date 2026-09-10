// Read-only extractor for a Mercari Shops inquiry detail page.
// Usage:
// 1. Open the inquiry detail page in the logged-in Chrome profile.
// 2. Paste this script into DevTools Console and press Enter.
// 3. Read the printed JSON.

(() => {
  const normalize = (text) => (text || "").replace(/\s+/g, " ").trim();

  const valueAfterLabel = (label) => {
    const nodes = Array.from(document.querySelectorAll("p, dt, th, span, div"));
    const labelNode = nodes.find((node) => normalize(node.textContent) === label);
    if (!labelNode) return null;

    const row = labelNode.closest("li, tr, [role='listitem']");
    if (row) {
      if (label === "商品ID") {
        const productLink = row.querySelector("a[href*='/products/']");
        if (productLink) return normalize(productLink.textContent);
      }

      const values = Array.from(row.querySelectorAll("a, p, span, div, dd, td"))
        .map((node) => normalize(node.textContent))
        .filter(Boolean)
        .filter((text, index, array) => array.indexOf(text) === index && text !== label);

      if (values.length) return values[values.length - 1];
    }

    let current = labelNode;
    for (let index = 0; index < 8 && current; index += 1) {
      current = current.nextElementSibling;
      const value = normalize(current && current.textContent);
      if (value && value !== label) return value;
    }

    return null;
  };

  const messageContent = () => {
    const heading = Array.from(document.querySelectorAll("h1, h2, h3"))
      .find((node) => normalize(node.textContent) === "メッセージ内容");
    if (!heading) return null;

    const nextHeading = Array.from(document.querySelectorAll("h1, h2, h3"))
      .find((node) => heading.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);

    const messages = Array.from(document.querySelectorAll("p"))
      .filter((node) => heading.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)
      .filter((node) => !nextHeading || (node.compareDocumentPosition(nextHeading) & Node.DOCUMENT_POSITION_FOLLOWING))
      .map((node) => normalize(node.textContent))
      .filter(Boolean)
      .filter((text) => text !== "メッセージ内容")
      .filter((text) => !/^\\d{4}年\\d{1,2}月\\d{1,2}日/.test(text))
      .filter((text) => !text.startsWith("※メッセージの内容は"))
      .filter((text) => text !== "もっと見る");

    if (messages.length >= 2) return messages[1];
    return messages[0] || null;
  };

  const productLink = document.querySelector("a[href*='/products/']");
  const result = {
    url: location.href,
    pageTitle: document.title,
    messageContent: messageContent(),
    customerName: valueAfterLabel("お客さま名"),
    productId: valueAfterLabel("商品ID") || normalize(productLink && productLink.textContent) || null,
    variantName: valueAfterLabel("種類名"),
    skuCode: valueAfterLabel("商品管理コード"),
    productHref: productLink ? productLink.href : null,
    extractedAt: new Date().toISOString(),
  };

  console.log(JSON.stringify(result, null, 2));
  return result;
})();
