// Fragrance-oil collections (owner's "Current Fragrance Oil Stock by
// Collection" sheet, October 2026). products.collection stores the key; the
// order here is the order collections and their oils appear on the site.
const COLLECTIONS = {
  hotel: 'Hotel Collection',
  social: 'Social Rooms Collection',
  relax: 'Relax Collection',
  signature: 'The Signature Collection',
  business: 'The Business Collection',
};

// The current oil line-up, by product slug, in sheet order.
const OIL_LINEUP = {
  hotel: ['fresh-blossom', 'white-tea', 'vienna', 'luxury', 'elegance', 'bvlgari', 'night-ambience',
    'magnolia-vanilla', 'white-orchid', 'citrus-whisper', 'beauty'],
  social: ['oud', 'sahara-night', 'oud-air', 'white-patchouli', 'macca'],
  relax: ['eucalyptus', 'melano', 'lavender', 'green-tea'],
  signature: ['white-rose', 'lacco', 'light-vanilla'],
  business: ['red-wood', 'fruit-and-honey', 'huboss', 'sole', 'pacivictus', 'secret'],
};

module.exports = { COLLECTIONS, OIL_LINEUP };
