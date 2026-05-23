import { describe, expect, it } from 'vitest'
import { cleanSystemMessageContent, extractReadableSystemMessageText } from './systemMessageFormatter'

const inviteSysmsg = `<sysmsg type="sysmsgtemplate">
  <sysmsgtemplate>
    <content_template>
      <plain><![CDATA["$username$"邀请"$names$"加入了群聊]]></plain>
      <template><![CDATA["$username$"邀请"$names$"加入了群聊]]></template>
      <link_list>
        <link name="username" type="link_profile">
          <memberlist>
            <member><username><![CDATA[wxid_zhangsan]]></username><nickname><![CDATA[张三]]></nickname></member>
          </memberlist>
        </link>
        <link name="names" type="link_profile">
          <memberlist>
            <member><username><![CDATA[wxid_lisi]]></username><nickname><![CDATA[李四]]></nickname></member>
            <member><username><![CDATA[wxid_wangwu]]></username><nickname><![CDATA[王五]]></nickname></member>
          </memberlist>
        </link>
      </link_list>
    </content_template>
  </sysmsgtemplate>
</sysmsg>`

const qrcodeJoinSysmsg = `<sysmsg type="sysmsgtemplate">
  <sysmsgtemplate>
    <content_template>
      <plain><![CDATA["$adder$"通过扫描"$from$"分享的二维码加入群聊]]></plain>
      <link_list>
        <link name="adder" type="link_profile">
          <memberlist>
            <member><username><![CDATA[wxid_new_member]]></username><nickname><![CDATA[新成员]]></nickname></member>
          </memberlist>
        </link>
        <link name="from" type="link_profile">
          <memberlist>
            <member><username><![CDATA[wxid_share_member]]></username><nickname><![CDATA[分享者]]></nickname></member>
          </memberlist>
        </link>
      </link_list>
    </content_template>
  </sysmsgtemplate>
</sysmsg>`

describe('systemMessageFormatter', () => {
  it('expands group system message template variables from link members', () => {
    expect(extractReadableSystemMessageText(inviteSysmsg)).toBe('"张三"邀请"李四、王五"加入了群聊')
    expect(cleanSystemMessageContent(inviteSysmsg)).toBe('"张三"邀请"李四、王五"加入了群聊')
  })

  it('keeps unknown placeholders instead of deleting useful context', () => {
    expect(extractReadableSystemMessageText('<sysmsg><plain><![CDATA[$unknown$加入了群聊]]></plain></sysmsg>')).toBe('$unknown$加入了群聊')
  })

  it('expands QR code join system message template variables', () => {
    expect(extractReadableSystemMessageText(qrcodeJoinSysmsg)).toBe('"新成员"通过扫描"分享者"分享的二维码加入群聊')
    expect(cleanSystemMessageContent(qrcodeJoinSysmsg)).toBe('"新成员"通过扫描"分享者"分享的二维码加入群聊')
  })
})
