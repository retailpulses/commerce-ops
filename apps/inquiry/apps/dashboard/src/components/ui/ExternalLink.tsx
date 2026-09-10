interface ExternalLinkProps {
  href: string;
  label?: string;
}

export default function ExternalLink({ href, label }: ExternalLinkProps) {
  if (!href) {
    return <span className="text-sm text-gray-400">No URL</span>;
  }

  const display = label || href;

  return (
    <a
      href={href.startsWith("http") ? href : `https://${href}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800 hover:underline"
    >
      {display}
      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
        />
      </svg>
    </a>
  );
}
