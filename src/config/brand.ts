/** Thương hiệu — logo mới được import để Vite gắn hash, tránh cache file cũ. */
import logoPng from './logo.png';

export const APP_TITLE = 'Quản Lý Cửa Hàng';
export const APP_TAGLINE = 'Linh Kiện Âm Thanh';

export const LOGO_PNG = logoPng;
export const LOGO_PUBLIC = `/logo.png?v=${import.meta.env.VITE_BUILD_ID || '20260920'}`;
export const LOGO_SVG = `/logo.svg?v=${import.meta.env.VITE_BUILD_ID || '20260920'}`;
