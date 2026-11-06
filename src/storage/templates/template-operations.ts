import type { TemplateStorage } from "./templates.js";
export class TemplateOperations {
  constructor(private readonly context: { templates: TemplateStorage }) {}
  localTemplates() {
    return this.context.templates.view();
  }
  templateDraft(id: string) {
    return this.context.templates.read(id);
  }
}
