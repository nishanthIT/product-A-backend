import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

/**
 * Pack Size Comparison ("smart purchase recommendation").
 *
 * Pack variants of the same product live as separate Product rows sharing the
 * same title with different packetSize/retailSize (see seed data — e.g.
 * "Amber Leaf" 30g vs 50g). This endpoint finds all sibling variants of a
 * product, computes the effective lowest price of each, derives a unit price
 * and flags the best-value option.
 */

// Effective price logic mirrors listRoutes.js (offerPrice + offerExpiryDate).
const getEffectivePrice = (productAtShop) => {
  const now = new Date();
  const hasActiveOffer =
    productAtShop.offerPrice != null &&
    productAtShop.offerExpiryDate != null &&
    new Date(productAtShop.offerExpiryDate) > now;

  return {
    price: parseFloat(hasActiveOffer ? productAtShop.offerPrice : productAtShop.price),
    originalPrice: parseFloat(productAtShop.price),
    offerPrice: hasActiveOffer ? parseFloat(productAtShop.offerPrice) : null,
    hasActiveOffer,
  };
};

const MULTI_RE = /(\d{1,4})\s*[x×]\s*(\d+(?:\.\d+)?)\s*(ml|cl|ltr|l|litre|litres|g|gm|kg|oz)?\b/i;
const SINGLE_RE = /(\d+(?:\.\d+)?)\s*(ml|cl|ltr|l|litre|litres|g|gm|kg|oz)\b/i;

const UNIT_FACTORS = {
  ml: { family: "vol", factor: 1 },
  cl: { family: "vol", factor: 10 },
  l: { family: "vol", factor: 1000 },
  ltr: { family: "vol", factor: 1000 },
  litre: { family: "vol", factor: 1000 },
  litres: { family: "vol", factor: 1000 },
  g: { family: "wt", factor: 1 },
  gm: { family: "wt", factor: 1 },
  kg: { family: "wt", factor: 1000 },
  oz: { family: "wt", factor: 28.35 },
};

/**
 * Parses pack structure from packetSize / title.
 * Returns { count, measure, family, sizeText } — count defaults to 1.
 */
const parsePackInfo = (product) => {
  const sources = [product.packetSize, product.retailSize, product.title]
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter((s) => s && s.toUpperCase() !== "N/A");

  for (const source of sources) {
    const multi = source.match(MULTI_RE);
    if (multi) {
      const count = parseInt(multi[1], 10) || 1;
      const value = parseFloat(multi[2]);
      const unit = (multi[3] || "").toLowerCase();
      const meta = UNIT_FACTORS[unit];
      return {
        count,
        measure: meta ? value * meta.factor : null,
        family: meta ? meta.family : null,
        sizeText: unit ? `${multi[2]}${unit}` : multi[2],
      };
    }
  }

  for (const source of sources) {
    const single = source.match(SINGLE_RE);
    if (single) {
      const value = parseFloat(single[1]);
      const unit = single[2].toLowerCase();
      const meta = UNIT_FACTORS[unit];
      return {
        count: 1,
        measure: meta ? value * meta.factor : null,
        family: meta ? meta.family : null,
        sizeText: `${single[1]}${unit}`,
      };
    }
  }

  // No parseable measure — fall back to raw packetSize text when present.
  const raw = typeof product.packetSize === "string" ? product.packetSize.trim() : "";
  return {
    count: 1,
    measure: null,
    family: null,
    sizeText: raw && raw.toUpperCase() !== "N/A" ? raw : null,
  };
};

// GET /products/:id/pack-options
const getPackOptions = async (req, res) => {
  try {
    const { id } = req.params;

    const product = await prisma.product.findUnique({ where: { id } });
    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }

    // Sibling variants share the same title (case-insensitive).
    const variants = await prisma.product.findMany({
      where: {
        title: { equals: product.title.trim(), mode: "insensitive" },
      },
      include: {
        shops: {
          where: { outOfStock: false },
        },
      },
      take: 25,
    });

    const options = variants
      .map((variant) => {
        const prices = variant.shops.map((s) => getEffectivePrice(s));
        const best = prices.length
          ? prices.reduce((min, p) => (p.price < min.price ? p : min))
          : null;
        const pack = parsePackInfo(variant);

        return {
          productId: variant.id,
          title: variant.title,
          barcode: variant.barcode,
          img: variant.img,
          packetSize: variant.packetSize,
          retailSize: variant.retailSize,
          caseSize: variant.caseSize,
          category: variant.category,
          availableInShops: variant.shops.length,
          price: best ? best.price : null,
          originalPrice: best ? best.originalPrice : null,
          hasActiveOffer: best ? best.hasActiveOffer : false,
          packCount: pack.count,
          sizeText: pack.sizeText,
          sizeLabel: pack.sizeText ? `${pack.count} × ${pack.sizeText}` : null,
          // Price per single item inside the pack (what shoppers compare).
          unitPrice: best && pack.count > 0 ? best.price / pack.count : null,
          isCurrent: variant.id === id,
          isBestValue: false,
          _family: pack.family,
          _normalizedCost:
            best && pack.count > 0
              ? best.price / (pack.count * (pack.measure ?? 1))
              : null,
        };
      })
      // Only priced options are useful for comparison.
      .filter((o) => o.price != null || o.isCurrent);

    // Best value: cheapest normalized cost among options comparable with the
    // requested product (same measure family, or both without one).
    const current = options.find((o) => o.isCurrent);
    const comparable = options.filter(
      (o) => o._normalizedCost != null && (!current || o._family === current._family)
    );
    if (comparable.length >= 2) {
      const best = comparable.reduce((min, o) =>
        o._normalizedCost < min._normalizedCost ? o : min
      );
      best.isBestValue = true;
    }

    const cleaned = options
      .map(({ _family, _normalizedCost, ...rest }) => rest)
      .sort((a, b) => (a.packCount || 1) - (b.packCount || 1));

    res.json({
      productId: id,
      options: cleaned,
      hasOptions: cleaned.length > 1,
    });
  } catch (error) {
    console.error("Error fetching pack options:", error);
    res.status(500).json({ error: "Failed to fetch pack options" });
  }
};

export { getPackOptions };
