import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Chessboard } from 'react-chessboard';
import type { Arrow, PromotionPieceOption, Square } from 'react-chessboard/dist/chessboard/types';
import { Chess } from 'chess.js';

export interface BoardArrow {
  from: string;
  to: string;
  color: string;
}

interface BoardProps {
  fen: string;
  orientation: 'white' | 'black';
  onMove?: (uci: string) => void;
  arrows?: BoardArrow[];
  highlight?: Record<string, CSSProperties>;
  interactive?: boolean;
}

function safeChess(fen: string): Chess {
  try {
    return new Chess(fen);
  } catch {
    return new Chess();
  }
}

export function Board({ fen, orientation, onMove, arrows = [], highlight = {}, interactive = true }: BoardProps) {
  const chess = useMemo(() => safeChess(fen), [fen]);
  const [promoOpen, setPromoOpen] = useState(false);
  const pendingPromo = useRef<{ from: Square; to: Square } | null>(null);
  const [selected, setSelected] = useState<Square | null>(null);
  const selectedRef = useRef<Square | null>(null); // mirror: immediate reads between batched clicks
  const select = (sq: Square | null) => {
    selectedRef.current = sq;
    setSelected(sq);
  };
  const [width, setWidth] = useState(480);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setWidth(Math.max(240, Math.min(el.clientWidth, 640)));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // new position → clear selection
  useEffect(() => select(null), [fen]);

  const legalFrom = (sq: Square) => {
    try {
      return chess.moves({ square: sq, verbose: true });
    } catch {
      return [];
    }
  };

  const commitMove = (from: Square, to: Square): boolean => {
    const match = legalFrom(from).find(m => m.to === to);
    if (!match) return false;
    if (match.promotion) {
      pendingPromo.current = { from, to };
      setPromoOpen(true);
      return true;
    }
    onMove?.(`${from}${to}`);
    return true;
  };

  const handlePieceDrop = (from: Square, to: Square): boolean => {
    const ok = commitMove(from, to);
    if (ok) setSelected(null);
    return ok;
  };

  // click-to-move: first click selects a piece, second click on a legal target plays it
  const handleSquareClick = (square: Square): void => {
    if (!interactive || !onMove) return;
    const sel = selectedRef.current;
    if (sel) {
      if (square === sel) {
        select(null);
        return;
      }
      if (commitMove(sel, square)) {
        select(null);
        return;
      }
    }
    // (re)select if the clicked square has a movable piece of the side to move
    select(legalFrom(square).length > 0 ? square : null);
  };

  const handlePromoSelect = (piece?: PromotionPieceOption): boolean => {
    const pending = pendingPromo.current;
    setPromoOpen(false);
    pendingPromo.current = null;
    if (piece && pending) {
      onMove?.(`${pending.from}${pending.to}${piece[1].toLowerCase()}`);
      return true;
    }
    return false;
  };

  const arrowTuples = arrows.map(a => [a.from, a.to, a.color] as unknown as Arrow);

  // selection highlight + legal-move dots, merged over caller styles
  const squareStyles: Record<string, CSSProperties> = { ...highlight };
  if (interactive && selected) {
    squareStyles[selected] = { ...squareStyles[selected], backgroundColor: 'rgba(138, 180, 248, 0.55)' };
    for (const m of legalFrom(selected)) {
      squareStyles[m.to] = {
        ...squareStyles[m.to],
        background: 'radial-gradient(circle, rgba(20,23,28,0.35) 20%, transparent 23%)',
      };
    }
  }

  return (
    <div className="board-container" ref={containerRef}>
      <Chessboard
        position={fen}
        boardWidth={width}
        boardOrientation={orientation}
        arePiecesDraggable={interactive && !!onMove}
        onPieceDrop={handlePieceDrop}
        onSquareClick={handleSquareClick}
        showPromotionDialog={promoOpen}
        onPromotionPieceSelect={handlePromoSelect}
        customArrows={arrowTuples}
        customSquareStyles={squareStyles}
        customDarkSquareStyle={{ backgroundColor: '#7d8fa3' }}
        customLightSquareStyle={{ backgroundColor: '#c9d3dd' }}
      />
    </div>
  );
}
