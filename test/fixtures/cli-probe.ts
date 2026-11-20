import { writeFileSync } from "node:fs";
import { AssistantMessageComponent, VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences, visibleWidth, type TUI } from "@earendil-works/pi-tui";

interface TreeComponent {
  constructor: { name: string };
  children?: TreeComponent[];
  mouseLayout?: { width: number; children: { height: number }[] };
  lastMessage?: { role: string };
  isStreaming?: boolean;
  messageId?: string;
  markdownSlots?: { kind: string }[];
}
interface Box { component: TreeComponent; children: Box[]; scrollContentLines?: string[]; rect: object }

/** Test-only metadata probe for an isolated synthetic CLI session. No message contents are dumped. */
export default function (pi: ExtensionAPI) {
  let tui: TUI | undefined;
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setWidget("marker-cli-probe", (value) => {
      tui = value;
      return { render: () => [], invalidate() {} };
    });
  });
  pi.registerCommand("marker-probe", {
    description: "Test-only fixture diagnostics",
    handler: async (_args, ctx) => {
      const path = process.env.PI_MARKER_PROBE_FILE;
      if (!path || !tui) throw new Error("Probe requires PI_MARKER_PROBE_FILE and a TUI");
      const raw = tui as unknown as { currentLayout?: { root: Box }; getScreenLines(): string[] };
      const nodes: object[] = [];
      const visitComponent = (component: TreeComponent, depth: number) => {
        if (depth > 8 || nodes.length >= 80) return;
        nodes.push({ depth, name: component.constructor.name,
          isAssistant: component instanceof AssistantMessageComponent,
          isPlainContainer: Object.getPrototypeOf(component) === Container.prototype,
          mouseWidth: component.mouseLayout?.width,
          children: component.children?.length,
          role: component.lastMessage?.role, streaming: component.isStreaming,
          hasId: !!component.messageId, slots: component.markdownSlots?.map((slot) => slot.kind) });
        for (const child of component.children ?? []) visitComponent(child, depth + 1);
      };
      const boxes: object[] = [];
      const visitBox = (box: Box) => {
        if (box.scrollContentLines) {
          boxes.push({ rect: box.rect, rows: box.scrollContentLines.length });
          if (box.children[0]) visitComponent(box.children[0].component, 0);
        }
        for (const child of box.children) visitBox(child);
      };
      if (raw.currentLayout) visitBox(raw.currentLayout.root);
      const screen = raw.getScreenLines();
      const yellowText = screen.flatMap((line) => [...line.matchAll(/\x1b\[48;2;255;220;85m([^\x1b]*)/g)].map((match) => match[1])).join("");
      const lines = screen.map(stripTerminalSequences);
      const row = lines.findIndex((line) => line.includes("marker target"));
      const line = lines[row] ?? "";
      const col = visibleWidth(line.slice(0, line.indexOf("marker target")));
      writeFileSync(path, JSON.stringify({ version: VERSION, yellowText, boxes, nodes,
        branchAssistants: ctx.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "assistant").length,
        fixtureLocation: row < 0 ? null : { row, start: col, end: col + "marker target".length - 1 },
      }, null, 2));
    },
  });
}
