import WaveSurfer from "wavesurfer.js";

import { val, Val } from "value-enhancer";
import { Node, Path, Point, Location, Range, Editor, Operation, Span, SelectionMode, SetSelectionOperation, SplitNodeOperation } from "slate";
import { isElement, isLeaf, Leaf, splitElement, splitLeaf, Element } from "./data";
import { RegionsHub } from "./regionsHub";
import { toSeconds } from "./utils";

export class State {

    public readonly zoom$: Val<number> = val(50);

    readonly #editor: Editor;
    readonly #regionsHub: RegionsHub;

    #wavesurfer: WaveSurfer | null = null;
    #selectedLinesSet: Set<Val<boolean>> = new Set();

    #lastAnchor: Point | null = null;
    #lastSelected$: Val<boolean> | null = null;
    #lastLeafPosition: number = -1;
    #waitSplitLeafs: [Leaf, Leaf] | null = null;

    public constructor(editor: Editor) {
        const protoApply = editor.apply;
        this.#editor = editor;
        this.#regionsHub = new RegionsHub(editor);
        editor.apply = operation => this.#injectApply(protoApply, operation);
    }

    public get regionsHub(): RegionsHub {
        return this.#regionsHub;
    }

    public bindWaveSurfer(wavesurfer: WaveSurfer): void {
        this.#wavesurfer = wavesurfer;
    }

    #injectApply(protoApply: Editor["apply"], operation: Operation): void {
        switch (operation.type) {
            case "split_node": {
                this.#splitNode(operation);
                break;
            }
            case "set_selection": {
                protoApply(operation);
                this.#onSelectionChange(operation);
                break;
            }
            default: {
                protoApply(operation);
                break;
            }
        }
    }

    #splitNode({ path, position }: SplitNodeOperation): void {
        if (path.length === 0) {
            return;
        }
        const editor = this.#editor;
        const node = Node.get(editor, path);

        if (isLeaf(node)) {
            this.#lastLeafPosition = position;
            if (position > 0 && position < node.text.length) {
                // cannot split on this tick or fail.
                // I don't know why, but it works.
                this.#waitSplitLeafs = splitLeaf(node, position);
                setTimeout(() => this.#waitSplitLeafs = null, 0);
            }
        } else if (isElement(node)) {
            if (position === 1 && this.#lastLeafPosition === 0) {
                // to fix cannot press enter at the beginning of the line.
                // I don't know why, but it works.
                position = 0;
            }
            const [left, right] = splitElement(node, position);
            const nextPath = this.#nextPath(path);

            if (this.#waitSplitLeafs) {
                const [leftLeaf, rightLeaf] = this.#waitSplitLeafs;
                left.children[left.children.length - 1] = leftLeaf;
                right.children.unshift(rightLeaf);
            }
            for (const selected$ of this.#selectedLinesSet) {
                selected$.set(false);
            }
            this.#selectedLinesSet.clear();

            Promise.resolve().then(() => {
                editor.removeNodes({ at: path });
                editor.insertNodes(left, { at: path });
                editor.insertNodes(right, { at: nextPath });
                editor.select({
                    path: editor.first(nextPath)[1],
                    offset: 0,
                });
            });
        }
    }

    #nextPath(path: Path): Path {
        const nextPath = [...path];
        nextPath[nextPath.length - 1] += 1;
        return nextPath;
    }

    #onSelectionChange(operation: SetSelectionOperation): void {
        let selectNothing = true;
        if (operation.newProperties) {
            const [begin, end] = this.#updateAndGetPoints(operation.newProperties as Range);
            const [chooseNode, _selectNothing] = this.#findChooseNode(begin, end);
            this.#selectLines(begin, end);
            if (chooseNode) {
                this.#chooseSelectedNode(chooseNode);
            }
            selectNothing = _selectNothing;
        }
        if (selectNothing) {
            this.#chooseSelectedNode(null);
        }
    }

    #selectLines(begin: Point, end: Point): void {
        const nextSelectedLinesSet = new Set<Val<boolean>>();
        let firstElement: Element | null = null;

        for (let i = begin.path[0]; i <= end.path[0]; i ++) {
            const node = Node.get(this.#editor, [i]);
            if (isElement(node)) {
                const selected$ = node.selected$;
                nextSelectedLinesSet.add(selected$);
                this.#selectedLinesSet.delete(selected$);
                selected$.set(true);
                if (!firstElement) {
                    firstElement = node;
                }
            }
        }
        for (const selected$ of this.#selectedLinesSet) {
            selected$.set(false);
        }
        this.#selectedLinesSet = nextSelectedLinesSet;

        if (firstElement && this.#wavesurfer) {
            const zoom = this.zoom$.value;
            const selectedBegin = toSeconds(firstElement.begin);
            const selectedEnd = toSeconds(firstElement.end);
            const selectedWidth = selectedEnd - selectedBegin;
            const scrollBegin = this.#wavesurfer.getScroll() / zoom;
            const scrollWidth = this.#wavesurfer.getWidth() / zoom;
            const scrollEnd = scrollBegin + scrollWidth;

            if (selectedWidth >= scrollWidth) {
                if (scrollEnd < selectedBegin || scrollBegin > selectedEnd) { // not touch
                    this.#wavesurfer.setScrollTime(selectedBegin);
                }
            } else if (selectedBegin < scrollBegin || selectedEnd > scrollEnd) { // not include
                const time = selectedBegin - (scrollWidth - selectedWidth) * 0.15;
                this.#wavesurfer.setScrollTime(time);
            }
        }
    }

    #findChooseNode(begin: Point, end: Point): [Leaf | null, boolean] {
        let selectNothing = true;
        let chooseNode: Leaf | null = null;

        if (Point.equals(begin, end)) {
            const node = this.#searchNode(begin);
            chooseNode = node || null;
            selectNothing = false;

            if (chooseNode && begin.offset === 0 && begin.path[1] !== 0) {
                // offset 为 0 时，实际上打字会插入上一个节点。
                // 调整行为，让高亮选择的节点永远是打字输入的节点。
                const beforePath = this.#editor.before(begin);
                if (beforePath) {
                    const beforeNode = this.#searchNode(beforePath!, "lowest");
                    if (beforeNode) {
                        chooseNode = beforeNode;
                    }
                }
            }
        } else {
            const nodeBegin = this.#searchNode(begin, "lowest");
            const nodeEnd = this.#searchNode(end, "lowest");
            const selectedBegin$ = (nodeBegin as any)?.selected$;
            const selectedEnd$ = (nodeEnd as any)?.selected$;
            if (selectedBegin$ && selectedEnd$ && selectedBegin$ === selectedEnd$) {
                chooseNode = nodeBegin || null;
                selectNothing = false;
            }
        }
        return [chooseNode, selectNothing];
    }

    #updateAndGetPoints({ anchor, focus }: Range): [Point, Point] {
        if (anchor) {
            this.#lastAnchor = anchor;
        } else if (this.#lastAnchor) {
            anchor = this.#lastAnchor;
        }
        if (!anchor && !focus) {
            throw new Error("invalid state");
        }
        if (!anchor || !focus) {
            const point = anchor || focus;
            return [point, point];
        }
        if (Point.isBefore(anchor, focus)) {
            return [anchor, focus];
        } else {
            return [focus, anchor];
        }
    }

    #chooseSelectedNode(node: Leaf | null): void {
        let cleanLastSelected = true;
        if (node) {
            const selected$ = (node as any).selected$;
            if (selected$) {
                if (selected$ !== this.#lastSelected$) {
                    selected$.set(true);
                    this.#lastSelected$?.set(false);
                    this.#lastSelected$ = selected$;
                }
                cleanLastSelected = false;
            }
        }
        if (cleanLastSelected && this.#lastSelected$) {
            this.#lastSelected$.set(false);
            this.#lastSelected$ = null;
        }
    }

    #searchNode(at: Location | Span, mode?: SelectionMode): Leaf | undefined {
        const result = this.#editor.nodes({ at, mode });
        let node: Leaf | undefined;
        for (const [_node, _path] of result) {
            node = _node as Leaf;
        }
        return node;
    }
}