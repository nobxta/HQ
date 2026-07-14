import Link from "next/link";

export interface Crumb {
  name: string;
  href: string;
}

const SITE = "https://hqadz.io";

export default function Breadcrumbs({ items }: { items: Crumb[] }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: `${SITE}${item.href}`,
    })),
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <nav aria-label="Breadcrumb" className="text-[13px] text-[#5d5d66]">
        <ol className="flex flex-wrap items-center gap-1.5">
          {items.map((item, i) => {
            const isLast = i === items.length - 1;
            return (
              <li key={item.href} className="flex items-center gap-1.5">
                {isLast ? (
                  <span className="text-[#8b8b93]" aria-current="page">{item.name}</span>
                ) : (
                  <Link href={item.href} className="hover:text-white transition-colors duration-150">
                    {item.name}
                  </Link>
                )}
                {!isLast && <span className="text-[#3d3d44]">/</span>}
              </li>
            );
          })}
        </ol>
      </nav>
    </>
  );
}
