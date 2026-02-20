export interface SnsLivePhoto {
    url: string
    thumb: string
    token?: string
    key?: string
    encIdx?: string
}

export interface SnsMedia {
    url: string
    thumb: string
    md5?: string
    token?: string
    key?: string
    encIdx?: string
    livePhoto?: SnsLivePhoto
}

export interface SnsComment {
    id: string
    nickname: string
    content: string
    refCommentId: string
    refNickname?: string
}

export interface SnsPost {
    id: string
    username: string
    nickname: string
    avatarUrl?: string
    createTime: number
    contentDesc: string
    type?: number
    media: SnsMedia[]
    likes: string[]
    comments: SnsComment[]
    rawXml?: string
    linkTitle?: string
    linkUrl?: string
}

export interface SnsLinkCardData {
    title: string
    url: string
    thumb?: string
}
