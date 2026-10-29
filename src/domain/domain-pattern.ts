const WILDCARD_PREFIX = '*.';

// "example.com" coincide solo consigo mismo; "*.example.com", con cualquier subdominio
// (de cualquier nivel), pero no con "example.com"
export function matchesDomainPattern(domain: string, pattern: string): boolean {
  const normalizedDomain = domain.toLowerCase();
  const normalizedPattern = pattern.toLowerCase();

  if (normalizedPattern.startsWith(WILDCARD_PREFIX)) {
    return normalizedDomain.endsWith(normalizedPattern.slice(1));
  }
  return normalizedDomain === normalizedPattern;
}
