function array(value = []) {
  return Array.isArray(value) ? value : [];
}

export function summarizeHome({ reviews = [], examples = [] } = {}) {
  const storedReviews = array(reviews);
  const pageCount = storedReviews.reduce((total, review) => total + Number(review.pageCount || 0), 0);
  const annotatedReviews = storedReviews.filter((review) => review.documentAnnotation?.status === 'ready').length;
  return {
    storedReviews: storedReviews.length,
    totalPages: pageCount,
    annotatedReviews,
    examples: array(examples).length
  };
}
