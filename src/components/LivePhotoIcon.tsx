import React from 'react';

interface LivePhotoIconProps {
    size?: number | string;
    className?: string;
    style?: React.CSSProperties;
}

export const LivePhotoIcon: React.FC<LivePhotoIconProps> = ({ size = 24, className = '', style = {} }) => {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            version="1.1"
            xmlns="http://www.w3.org/2000/svg"
            className={className}
            style={style}
        >
            <g stroke="none" strokeWidth="1" fill="none" fillRule="evenodd" strokeLinecap="round" strokeLinejoin="round">
                <g stroke="currentColor" strokeWidth="2">
                    <circle fill="currentColor" stroke="none" cx="12" cy="12" r="2.5"></circle>
                    <circle cx="12" cy="12" r="5.5"></circle>
                    <circle cx="12" cy="12" r="9" strokeDasharray="1 3.7"></circle>
                </g>
            </g>
        </svg>
    );
};
