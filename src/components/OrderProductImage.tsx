import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/** Shared thumbnail and full-size preview for order tables, cards and details. */
export function OrderProductImage({ src, alt, className, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    dialog?.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      dialog?.close();
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="block shrink-0 rounded-lg cursor-zoom-in focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500"
        title="Phóng to ảnh sản phẩm"
        aria-label={`Phóng to ảnh: ${alt || 'Sản phẩm'}`}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
      >
        <img {...props} src={src} alt={alt} className={className} />
      </button>
      {open && createPortal(
        <dialog
          ref={dialogRef}
          aria-label={`Ảnh sản phẩm: ${alt || 'Sản phẩm'}`}
          className="fixed inset-0 m-0 w-screen max-w-none h-dvh max-h-none border-0 bg-black/80 p-6 backdrop:bg-transparent"
          onClose={() => setOpen(false)}
          onClick={(event) => {
            event.stopPropagation();
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <div
            className="flex h-full w-full items-center justify-center"
            onClick={(event) => {
              event.stopPropagation();
              if (event.target === event.currentTarget) setOpen(false);
            }}
          >
            <button
              type="button"
              autoFocus
              className="absolute right-4 top-4 rounded-full bg-white p-2 text-gray-800 hover:bg-gray-200"
              aria-label="Đóng ảnh phóng to"
              onClick={() => setOpen(false)}
            >
              <X className="h-6 w-6" />
            </button>
            <img
              src={src}
              alt={alt || 'Sản phẩm'}
              referrerPolicy={props.referrerPolicy}
              className="max-h-[85dvh] max-w-[90vw] rounded-lg object-contain bg-white"
            />
          </div>
        </dialog>,
        document.body,
      )}
    </>
  );
}
