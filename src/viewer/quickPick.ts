import * as vscode from 'vscode';
import { MemberInfo, TypeInfo } from '../engine/protocol';

export class TypeQuickPick {
  static async pick(types: TypeInfo[], placeHolder: string): Promise<TypeInfo | undefined> {
    const items = types.map((type) => ({
      label: type.fullName,
      description: `${type.kind} · ${type.memberCount} members`,
      detail: type.accessibility,
      type,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder,
      matchOnDescription: true,
      matchOnDetail: true,
    });

    return selected?.type;
  }

  static async pickMember(members: MemberInfo[], placeHolder: string): Promise<MemberInfo | undefined> {
    const items = members.map((member) => ({
      label: member.name,
      description: member.kind,
      detail: member.signature,
      member,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder,
      matchOnDescription: true,
      matchOnDetail: true,
    });

    return selected?.member;
  }
}
