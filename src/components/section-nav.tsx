"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/** How far below the window top a section counts as the one being read (the header is sticky). */
const READING_LINE = 120;

/**
 * A page's table of contents: links to its sections, with the section in view highlighted as the
 * page scrolls (the last one once the bottom is reached).
 */
export function SectionNav({ sections, label }: { sections: { id: string; label: string }[]; label: string }) {
  const [active, setActive] = useState<string | null>(sections[0]?.id ?? null);
  const ids = sections.map((s) => s.id).join(" ");

  useEffect(() => {
    const elements = ids
      .split(" ")
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
        const passed = elements.filter((el) => el.getBoundingClientRect().top <= READING_LINE);
        setActive(atBottom ? elements[elements.length - 1].id : (passed.at(-1) ?? elements[0]).id);
      });
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [ids]);

  return (
    <nav aria-label={label} className="sticky top-16 flex h-fit w-48 shrink-0 flex-col gap-0.5 border-l text-sm">
      {sections.map((section) => (
        <a
          key={section.id}
          href={`#${section.id}`}
          aria-current={active === section.id ? "location" : undefined}
          onClick={() => setActive(section.id)}
          className={cn(
            "-ml-px border-l-2 px-3 py-1 transition-colors",
            active === section.id ? "border-primary text-foreground bg-muted font-medium" : "text-muted-foreground hover:text-foreground border-transparent",
          )}
        >
          {section.label}
        </a>
      ))}
    </nav>
  );
}
