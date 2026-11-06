import { Button } from "@heroui/react";
import type { SkillSummary } from "../../../shared/tools/skills.js";

export function LocalPluginSkills({
  skills,
  onOpen,
}: {
  skills: SkillSummary[];
  onOpen(skill: SkillSummary): void;
}) {
  if (!skills.length) return null;
  return (
    <section aria-label="本地技能" className="local-plugin-skills">
      <h3>本地技能</h3>
      {skills.map((skill) => (
        <Button
          key={skill.id}
          variant="ghost"
          aria-label={"打开技能 " + skill.name}
          onPress={() => onOpen(skill)}
        >
          {skill.name}
        </Button>
      ))}
    </section>
  );
}
